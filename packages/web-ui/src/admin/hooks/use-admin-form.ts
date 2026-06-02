/**
 * useAdminForm — shared shell for every admin form.
 *
 * Locks in three cross-cutting concerns that every form needs:
 *
 * 1. `isDirty` drives Save button disable state. No hand-rolled
 *    `dirty = a !== init.a || ...` chains, no forgotten fields.
 * 2. Mutation success auto-rebaselines the form via `reset(submitted)`,
 *    so `isDirty` flips back to false and the same data is not
 *    re-submittable until the user edits again.
 * 3. A status banner (ok/error) shows on mutation result and clears
 *    automatically when the user edits any field.
 *
 * The form schema is typed via zod; `values` is RHF's declarative
 * external-data sync (an object reference change replaces the form
 * baseline). With the SSE-driven invalidator in place, `values` comes
 * from a live tRPC query — edits on disk surface in-form within ~1s.
 *
 * Usage:
 *
 *   const { form, message, submitProps, formProps } = useAdminForm({
 *     schema: MutationInputSchema,
 *     values: { ...currentFromServer },
 *     mutation: trpc.foo.update,
 *     toPayload: (v) => v,                  // or transformer
 *     successText: 'Saved',
 *     onSaved: () => utils.foo.get.invalidate(),
 *   });
 *
 *   <form {...formProps}>
 *     <input {...form.register('field')} />
 *     {message && <StatusMessage {...message} />}
 *     <button {...submitProps}>Save</button>
 *   </form>
 */
import { useState } from 'preact/hooks';
import { useForm, type UseFormReturn, type FieldValues, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import type { z } from 'zod';

export interface AdminFormStatus {
  type: 'ok' | 'error';
  text: string;
}

/** tRPC mutation hook factory — matches `trpc.foo.bar` shape. */
interface MutationHook<TInput, TOutput> {
  useMutation: (opts: {
    onSuccess?: (data: TOutput, variables: TInput) => void;
    onError?: (err: { message: string }) => void;
  }) => {
    mutate: (input: TInput) => void;
    isPending: boolean;
  };
}

export interface UseAdminFormResult<TValues extends FieldValues> {
  form: UseFormReturn<TValues>;
  message: AdminFormStatus | null;
  setMessage: (m: AdminFormStatus | null) => void;
  isPending: boolean;
  /** Spread onto `<form>` — handles onSubmit + onInput-to-clear-message. */
  formProps: {
    onSubmit: (e: Event) => void;
    onInput: () => void;
  };
  /** Spread onto the submit button — handles disabled + type=submit. */
  submitProps: {
    type: 'submit';
    disabled: boolean;
  };
}

export function useAdminForm<
  TValues extends FieldValues,
  TInput,
  TOutput,
>(opts: {
  schema: z.ZodType<TValues>;
  values: TValues;
  mutation: MutationHook<TInput, TOutput>;
  toPayload: (values: TValues) => TInput;
  successText?: string;
  onSaved?: (data: TOutput) => void;
}): UseAdminFormResult<TValues> {
  const [message, setMessage] = useState<AdminFormStatus | null>(null);

  const form = useForm<TValues>({
    // zodResolver expects the schema's `_input` type to extend FieldValues.
    // We type `schema` as `z.ZodType<TValues>` on the public API so callers
    // get good inference, but RHF's resolver generic demands the stricter
    // shape. Runtime is sound — schema.parse returns TValues which matches
    // TValues extends FieldValues. Cast isolated here.
    resolver: zodResolver(opts.schema as z.ZodType<TValues, TValues>) as Resolver<TValues>,
    values: opts.values,
  });

  const mutation = opts.mutation.useMutation({
    onSuccess: (data) => {
      setMessage({ type: 'ok', text: opts.successText ?? 'Saved' });
      // Re-baseline so isDirty → false. reset() accepts the current values
      // as the new baseline.
      form.reset(form.getValues());
      opts.onSaved?.(data);
    },
    onError: (err) => setMessage({ type: 'error', text: err.message }),
  });

  const onSubmit = form.handleSubmit(
    (values) => {
      mutation.mutate(opts.toPayload(values));
    },
    (errors) => {
      // Surface validation failures as a banner. Without this RHF silently
      // rejects the submit and the user gets no feedback. Field keys aren't
      // user-friendly labels but at least point at the wrong field.
      const fields = Object.keys(errors).join(', ');
      setMessage({ type: 'error', text: fields ? `Please fix: ${fields}` : 'Please fix the highlighted fields' });
    },
  );

  return {
    form,
    message,
    setMessage,
    isPending: mutation.isPending,
    formProps: {
      onSubmit,
      onInput: () => { if (message) setMessage(null); },
    },
    submitProps: {
      type: 'submit',
      disabled: mutation.isPending || !form.formState.isDirty,
    },
  };
}
