/** Output of a single cleaning pipeline. */
export type PipelineResult = {
  content: string;
  ext: string;
};

/** A pipeline transforms raw HTML into a cleaned representation. */
export type Pipeline = (html: string, meta: PageMeta) => PipelineResult;

/** Metadata extracted from the page before pipelines run. */
export type PageMeta = {
  url: string;
  title: string;
  description: string;
  contentType: string;
};

/** Token and byte size info for a single output file. */
export type SizeInfo = {
  bytes: number;
  tokens: number;
};

/** Full result returned by the fetch service. */
export type FetchResult = {
  meta: PageMeta & {
    fetchedAt: string;
    sizes: Record<string, SizeInfo>;
  };
  files: Record<string, string>;
  /** When 'base64', file values are base64-encoded binary data. */
  encoding?: 'base64';
  /** File extension for binary content (e.g., 'pdf', 'png'). */
  ext?: string;
};
