/**
 * Comprehensive regex matching ANSI / VT escape sequences.
 *
 * Breakdown of alternation groups (left-to-right, first match wins):
 *
 * 1. `\x1b\[[0-?]*[ -/]*[@-~]`
 *    CSI sequences — ESC `[` + optional parameter/intermediate bytes + final byte.
 *    Covers SGR (colours), cursor movement, erase, scroll, etc.
 *
 * 2. `\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)`
 *    OSC sequences — ESC `]` + arbitrary payload terminated by BEL (`\x07`)
 *    or ST (`ESC \`).  Handles hyperlinks, window titles, clipboard ops, etc.
 *
 * 3. `\x1b[PX^_][^\x1b]*\x1b\\`
 *    DCS / PM / APC / SOS — ESC + one of `P X ^ _` + payload + ST.
 *
 * 4. `\x1b[NO][\x40-\x7e]`
 *    SS2 / SS3 — two-byte designator sequences.
 *
 * 5. `\x1b[\x20-\x2f][\x30-\x7e]`
 *    Two-byte "nF" sequences (private-use range).
 *
 * 6. `\x1b[@-Z\\-_]`
 *    Simple two-byte ESC sequences (e.g. ESC A–Z, ESC \, ESC =).
 *
 * 7. `[\x00-\x08\x0e-\x1f\x7f]`
 *    Stray C0 control characters that are not newline (\x09\x0a\x0d) or tab.
 *    Includes BS, SO, SI, DEL, and most unused controls.
 *
 * The `g` flag is required for `replace`; the `u` flag enables full Unicode.
 */
const ANSI_REGEX =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][^\x1b]*\x1b\\|\x1b[NO][\x40-\x7e]|\x1b[\x20-\x2f][\x30-\x7e]|\x1b[@-Z\\-_]|[\x00-\x08\x0e-\x1f\x7f]/gu;

/**
 * Remove all ANSI / VT escape sequences and stray C0 control characters from
 * the input string, returning plain text suitable for display or analysis.
 *
 * Sequences handled:
 * - CSI sequences (SGR colours, cursor movement, erase, scroll, …)
 * - OSC sequences (hyperlinks, window titles, clipboard, …)
 * - DCS / PM / APC / SOS sequences
 * - SS2 / SS3 two-byte designators
 * - Simple two-byte ESC sequences
 * - Stray C0 control characters (excluding `\t`, `\n`, `\r`)
 *
 * @example
 * ```ts
 * stripAnsi('\x1b[32mHello\x1b[0m world'); // → 'Hello world'
 * stripAnsi('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'); // → 'link'
 * ```
 */
export function stripAnsi(input: string): string {
  // Reset lastIndex before each call; the `g` flag retains state on the
  // same regex object between calls, which would cause skipped matches.
  ANSI_REGEX.lastIndex = 0;
  return input.replace(ANSI_REGEX, '');
}

/**
 * Return `true` if the string contains at least one ANSI / VT escape sequence
 * or stray C0 control character recognised by {@link stripAnsi}.
 *
 * Useful as a cheap guard before paying the cost of a full strip operation.
 *
 * @example
 * ```ts
 * containsAnsi('\x1b[1mBold\x1b[0m'); // → true
 * containsAnsi('plain text');          // → false
 * ```
 */
export function containsAnsi(input: string): boolean {
  ANSI_REGEX.lastIndex = 0;
  return ANSI_REGEX.test(input);
}
