import { DocsLayout, H2, proseP, proseUl } from '../../../components/docs/DocsLayout';
import { Callout } from '../../../components/ui/Callout';
import { Code } from '../../../components/ui/Code';
import { FileSpec } from '../../../components/docs/FileSpec';
import { FieldTable } from '../../../components/docs/FieldTable';
import { ToolDoc } from '../../../components/docs/ToolDoc';

export function ExtensionsWebFetch() {
  return (
    <DocsLayout
      url="/docs/extensions/web-fetch"
      crumbs={['docs', 'plugins', 'extensions', 'web-fetch']}
      title="web-fetch"
      lede="Web page fetching as a capability — renders JavaScript, cleans the result into token-efficient markdown, and writes it to staging for the agent to read. Domain policy and SSRF protection always apply."
      toc={[
        { label: 'What the agent can do' },
        { label: 'Configuration' },
        { label: 'Tools' },
        { label: 'Notes & gotchas' },
      ]}
    >
      <Callout kind="warn">
        By default an agent's container runs a locked-down network (<code>sdk-only</code>),
        so Claude's built-in web-fetch can't reach the open web. This extension fetches
        host-side instead — the more secure path (every request is domain-policed and
        SSRF-protected) and the more efficient one (pages come back as cleaned,
        token-efficient markdown). On a full-network agent the built-in tool can reach out
        again, so prefer this one either way.
      </Callout>

      <H2>What the agent can do</H2>
      <ul style={proseUl}>
        <li>
          <strong>Fetch a URL</strong> — one tool: give it a URL, it renders the page, cleans
          it, and writes the result to staging, returning the paths for the agent to{' '}
          <code>Read</code>.
        </li>
        <li>
          <strong>Choose the output</strong> — token-efficient markdown by default, full
          markdown, or raw HTML; binary content (PDFs, images) is saved as-is.
        </li>
        <li>
          <strong>Pairs with search</strong> — the agent finds URLs with WebSearch, then
          fetches the specific pages it wants in full.
        </li>
      </ul>

      <H2>Configuration</H2>
      <p style={proseP}>
        Web-fetch needs no credentials. The one decision is how freely the agent may fetch,
        and which domains are off-limits.
      </p>
      <FileSpec name="capabilities.json" meta="json · extensions.web-fetch slice">
        <Code lang="json" noHead>{`{
  "extensions": {
    "web-fetch": {
      "enabled": true,
      "fetch_mode": "approval",
      "blocked_domains": ["*.internal.example.com"]
    }
  }
}`}</Code>
      </FileSpec>
      <FieldTable
        fields={[
          {
            name: 'fetch_mode',
            type: 'disabled | approval | open',
            default: 'approval',
            effect: 'disabled doesn’t register the tool; approval prompts unless the domain is allowlisted; open fetches freely.',
          },
          {
            name: 'allowed_domains',
            type: 'string[]',
            default: '[]',
            effect: (
              <>
                Domains that skip the prompt under <code>approval</code>. Wildcards like{' '}
                <code>*.example.com</code>.
              </>
            ),
          },
          {
            name: 'blocked_domains',
            type: 'string[]',
            default: '[]',
            effect: 'Always rejected, in every mode. Same wildcard syntax.',
          },
          {
            name: 'allow_query_strings',
            type: 'boolean',
            default: 'true',
            effect: 'When false, strips query strings and fragments before fetching.',
          },
        ]}
      />

      <H2>Tools</H2>

      <ToolDoc
        name="web__fetch"
        summary="Fetch a web page, run it through cleaning pipelines, and write the result to /staging/in/. Returns metadata plus the file paths the agent should Read."
        params={[
          { name: 'url', type: 'string', required: true, desc: 'URL to fetch — http or https only.' },
          { name: 'pipelines', type: 'string[]', default: '["crawl4ai"]', desc: 'Processing pipelines. Options: "crawl4ai" (cleaned markdown), "markdown" (full markdown), "raw" (unprocessed HTML).' },
        ]}
        returns={[
          { value: 'Title: <page title>\nURL: <normalized URL>\nContent-Type: <media type>\nFetched: <iso timestamp>\n\nFiles written:\n  /staging/in/fetch_<hash>.<pipeline>.<ext> (<N> tokens|bytes)\n  /staging/in/fetch_<hash>.meta.json\n\nUse the Read tool to access these files.', when: 'success' },
          { value: 'Internal addresses are not allowed.', when: 'SSRF block — hostname matches private ranges (127.*, 10.*, 192.168.*, ::1, etc.)' },
          { value: 'Domain "HOSTNAME" is blocked.', when: 'hostname in blocked_domains' },
          { value: 'Only http/https URLs are supported.', when: 'non-http/https protocol' },
          { value: 'Invalid URL: <url>', when: 'URL parsing failed' },
          { value: 'Fetch failed: <error>', when: 'network or parsing error' },
          { value: 'Web-fetch service is not running.', when: 'service spawn failed or crashed' },
        ]}
        notes="Output files live in /staging/in/ as fetch_<sha256(url)[:12]>.<pipeline>.<ext>. Text content uses .html (raw) or .md (crawl4ai/markdown); binary content is base64-encoded and saved with .bin or the detected extension. The meta.json sidecar carries title, description, contentType, fetchedAt, and per-pipeline sizes."
      />

      <H2>Notes &amp; gotchas</H2>
      <Callout kind="security">
        SSRF protection is always on, in every mode — loopback, link-local, and private-IP
        targets are refused regardless of the domain lists. Keep <code>fetch_mode</code> at{' '}
        <code>approval</code> with a populated <code>blocked_domains</code> rather than{' '}
        <code>open</code> with an empty list.
      </Callout>
      <Callout kind="tip">
        Files in <code>/staging/in/</code> are ephemeral and clear at conversation end. If
        the agent should remember a fetched page, it copies the markdown into{' '}
        <code>/memory/</code>.
      </Callout>
    </DocsLayout>
  );
}
