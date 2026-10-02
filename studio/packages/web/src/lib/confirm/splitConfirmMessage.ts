/**
 * #1397 — the title (first paragraph, up to the first blank line) and the body
 * paragraphs of a confirm message. Every message builder in the app leads with
 * the question, so the question becomes the dialog's title.
 */
export function splitConfirmMessage(message: string): {
  title: string;
  paragraphs: string[];
} {
  const [title = '', ...rest] = message.split(/\n\s*\n/);
  return { title: title.trim(), paragraphs: rest.map((p) => p.trim()).filter((p) => p !== '') };
}
