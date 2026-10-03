import { useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MAX_ANSWER_TEXT } from '@test-orbit/shared';

const INDENT = '    ';

/**
 * Plain-text code editor (no execution, no highlighting): monospace, preserves
 * whitespace, Tab/Shift+Tab indent/outdent, Enter keeps the current indentation.
 * Press Esc, then Tab, to move keyboard focus out of the editor.
 */
export function CodeEditor({ value, onChange, label, disabled }: { value: string; onChange: (v: string) => void; label: string; disabled?: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [escaped, setEscaped] = useState(false);
  const pendingSelection = useRef<[number, number] | null>(null);

  // Restore the caret synchronously after React commits the new value, before the
  // next keystroke is handled (a rAF here lets fast typing land in the wrong place).
  useLayoutEffect(() => {
    if (pendingSelection.current && ref.current) {
      ref.current.setSelectionRange(...pendingSelection.current);
      pendingSelection.current = null;
    }
  }, [value]);

  const replace = (start: number, end: number, text: string, cursorStart: number, cursorEnd = cursorStart) => {
    const next = value.slice(0, start) + text + value.slice(end);
    if (next.length > MAX_ANSWER_TEXT) return;
    pendingSelection.current = [cursorStart, cursorEnd];
    onChange(next);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    const { selectionStart: s, selectionEnd: t } = el;
    if (e.key === 'Escape') {
      setEscaped(true);
      return;
    }
    if (e.key === 'Tab' && !escaped) {
      e.preventDefault();
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      if (s === t && !e.shiftKey) {
        replace(s, t, INDENT, s + INDENT.length);
        return;
      }
      // Indent / outdent every selected line.
      const block = value.slice(lineStart, t);
      const lines = block.split('\n');
      const changed = e.shiftKey ? lines.map((l) => l.replace(/^( {1,4}|\t)/, '')) : lines.map((l) => INDENT + l);
      const text = changed.join('\n');
      const firstDelta = changed[0]!.length - lines[0]!.length;
      replace(lineStart, t, text, Math.max(lineStart, s + firstDelta), lineStart + text.length);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      const lineStart = value.lastIndexOf('\n', s - 1) + 1;
      const indent = /^[ \t]*/.exec(value.slice(lineStart, s))?.[0] ?? '';
      const extra = /[:{[(]\s*$/.test(value.slice(lineStart, s)) ? INDENT : '';
      if (indent || extra) {
        e.preventDefault();
        const insert = `\n${indent}${extra}`;
        replace(s, t, insert, s + insert.length);
      }
    }
    if (escaped) setEscaped(false);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-navy-800 bg-navy-950 shadow-inner focus-within:ring-2 focus-within:ring-brand-500/50">
      <div className="flex items-center justify-between border-b border-navy-800 px-4 py-2 text-xs text-white/60">
        <span>Your solution (not executed — reviewed manually)</span>
        <span className="tabular-nums">
          {value.length.toLocaleString()} / {MAX_ANSWER_TEXT.toLocaleString()}
        </span>
      </div>
      <textarea
        ref={ref}
        aria-label={label}
        aria-describedby="code-editor-help"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value.slice(0, MAX_ANSWER_TEXT))}
        onKeyDown={onKeyDown}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        wrap="off"
        className="block h-[44vh] min-h-72 w-full resize-y bg-transparent p-4 font-mono text-[13.5px] leading-6 whitespace-pre text-slate-100 caret-brand-400 outline-none placeholder:text-white/30"
        placeholder="// Write your code or explain your approach here"
      />
      <p id="code-editor-help" className="border-t border-navy-800 px-4 py-1.5 text-[11px] text-white/45">
        Tab indents · Shift+Tab outdents · Esc then Tab leaves the editor
      </p>
    </div>
  );
}
