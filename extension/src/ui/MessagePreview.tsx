import type { JSX } from 'react';
/** WhatsApp-style bubble. Renders *bold*, _italic_, ~strike~ and ```mono``` the way WhatsApp does. */
export function MessageBubble({ text }: { text: string }) {
  return (
    <div className="rounded-xl bg-[#efeae2] p-4 dark:bg-[#0b141a]">
      <div className="ml-auto max-w-[85%] rounded-lg rounded-tr-none bg-[#d9fdd3] px-3 py-2 text-sm whitespace-pre-wrap break-words text-slate-900 shadow-sm dark:bg-[#005c4b] dark:text-slate-50">
        {format(text)}
      </div>
    </div>
  );
}

function format(text: string) {
  const parts: (string | JSX.Element)[] = [];
  const re = /```([\s\S]+?)```|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~|(\{\{[^}]+\}\})/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1]) parts.push(<code key={i++} className="font-mono">{m[1]}</code>);
    else if (m[2]) parts.push(<strong key={i++}>{m[2]}</strong>);
    else if (m[3]) parts.push(<em key={i++}>{m[3]}</em>);
    else if (m[4]) parts.push(<s key={i++}>{m[4]}</s>);
    else if (m[5]) parts.push(<mark key={i++} className="rounded bg-red-200 px-0.5 text-red-900" title="No value for this placeholder">{m[5]}</mark>);
    last = re.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
