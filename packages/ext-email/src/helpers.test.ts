import { describe, expect, it } from 'vitest';

import { formatImapError } from './helpers.js';

function imapError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error('Command failed'), fields);
}

describe('formatImapError', () => {
  it('names a missing mailbox and points at email__list_folders', () => {
    const err = imapError({ mailboxMissing: true, responseText: 'Unknown Mailbox: Sent (Failure)' });
    expect(formatImapError(err, 'Sent')).toBe(
      'Folder "Sent" does not exist on this server. Use email__list_folders to see available folders.',
    );
  });

  it('handles a missing mailbox without a folder name', () => {
    const err = imapError({ mailboxMissing: true });
    expect(formatImapError(err)).toBe(
      'Folder does not exist on this server. Use email__list_folders to see available folders.',
    );
  });

  it('appends server response text verbatim for other command failures', () => {
    const err = imapError({ responseText: 'Too many simultaneous connections' });
    expect(formatImapError(err)).toBe('Command failed — server response: Too many simultaneous connections');
  });

  it('does not repeat response text already present in the message', () => {
    const err = imapError({ responseText: 'Command failed' });
    expect(formatImapError(err)).toBe('Command failed');
  });

  it('passes plain errors through unchanged', () => {
    expect(formatImapError(new Error('Email not found: 123'))).toBe('Email not found: 123');
  });

  it('stringifies non-Error throws', () => {
    expect(formatImapError('boom')).toBe('boom');
  });
});
