import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const plainUrl = (url: string) => url;
const markdownComponents: Components = {
  a({ children, href }) { return <span>{children}{href && children !== href && <span className="text-ink-tertiary"> ({href})</span>}</span>; },
  img({ alt, src }) { return <span>{alt}{src && <span className="text-ink-tertiary"> ({src})</span>}</span>; },
};

export function AgentDocumentMarkdown({ markdown }: { markdown: string }) {
  return <div dir="auto"
    className="min-w-0 text-[13px] leading-5 text-ink [overflow-wrap:anywhere] [&_h1]:mb-2 [&_h1]:text-[18px] [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-4 [&_h2]:text-[16px] [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_p+p]:mt-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:ps-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:ps-5 [&_pre]:my-2 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-inset [&_pre]:p-3 [&_code]:text-[12px] [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
    <Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={plainUrl} components={markdownComponents}>{markdown}</Markdown>
  </div>;
}
