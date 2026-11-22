// A fast, dependency-free re-implementation of csv-reader 1.0.0's readCsv.
//
// Same contract: run({text, header}) returns {columns, rows, errors} with
// exactly csv-reader's broken-row policy:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no
//     record;
//   - outside a quoted field a CR not followed by LF is dropped (stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it is one quote, and each CRLF or lone CR inside
//     it is read as LF; what follows its closing quote, up to the next
//     comma or line break, is appended as it stands (quote_junk, when the
//     field ends); a quote that never closes is a literal character, and
//     the text after it is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its field count) or cut (long_row,
//     with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}: line the 1-based line its record
//     starts on, row its record's index in rows (null for the header), in
//     the order met, a field's quote_junk when the field ends and a record's
//     short_row or long_row when the record ends.
//
// Only the scanning differs from the reference: instead of one character at
// a time, a field is located with indexOf (which scans in native code) and
// cut out with slice, and the per-character work is reserved for the rare
// paths (a stray CR inside a field, a doubled quote, a quoted newline).
// The hot paths are written inline in run() with plain locals, so the
// engine keeps them on the stack; the rare paths live in the module-level
// helpers below, which work on a small state object st.

// How a field ended: at a comma (the record goes on), at a line break, or
// at the end of the text (the record ends).
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

// Appends seg to value, dropping every lone CR in it (each one a stray_cr
// for the record being read). Returns [value, kept characters]. Only used
// when seg is known to hold a CR.
function appendDroppingCr(st, value, seg) {
  let kept = 0;
  let out = value;
  let from = 0;
  let cr = seg.indexOf('\r');
  while (cr !== -1) {
    st.errors.push({ code: 'stray_cr', line: st.recordLine, row: st.recordRow });
    if (cr > from) {
      out += seg.slice(from, cr);
      kept += cr - from;
    }
    from = cr + 1;
    cr = seg.indexOf('\r', from);
  }
  if (from < seg.length) {
    out += seg.slice(from);
    kept += seg.length - from;
  }
  return [out, kept];
}

// Reads an unquoted field from st.pos, starting from prefix ("" for a plain
// field, the quoted value for a quote's junk, '"' for an unterminated quote
// re-read). Returns [value, ended, added]; moves st.pos and st.line. A CR
// inside the field is always lone here: the field's end (the first comma
// or LF, or a CRLF's LF) bounds the segment, so a CR before it can only be
// followed by something other than LF.
function readUnquotedFrom(st, prefix) {
  const text = st.text;
  const n = text.length;
  let value = prefix;
  let added = 0;
  const comma = text.indexOf(',', st.pos);
  const nl = text.indexOf('\n', st.pos);
  let end;
  let isComma = false;
  if (comma === -1) end = nl;
  else if (nl === -1) {
    end = comma;
    isComma = true;
  } else if (comma < nl) {
    end = comma;
    isComma = true;
  } else end = nl;

  if (end === -1) {
    // No delimiter left: the rest of the text is the field.
    if (st.pos < n) {
      const seg = text.slice(st.pos);
      if (seg.indexOf('\r') === -1) {
        value = prefix === '' ? seg : value + seg;
        added += seg.length;
      } else {
        const r = appendDroppingCr(st, value, seg);
        value = r[0];
        added += r[1];
      }
    }
    st.pos = n;
    return [value, END, added];
  }

  if (isComma) {
    const seg = text.slice(st.pos, end);
    if (seg.indexOf('\r') === -1) {
      value = prefix === '' ? seg : value + seg;
      added += seg.length;
    } else {
      const r = appendDroppingCr(st, value, seg);
      value = r[0];
      added += r[1];
    }
    st.pos = end + 1;
    return [value, COMMA, added];
  }

  // The field ends at a line break: LF, or CRLF (a CR right before it).
  let segEnd = end;
  if (end > st.pos && text.charCodeAt(end - 1) === 13) segEnd = end - 1;
  const seg = text.slice(st.pos, segEnd);
  if (seg.indexOf('\r') === -1) {
    value = prefix === '' ? seg : value + seg;
    added += seg.length;
  } else {
    const r = appendDroppingCr(st, value, seg);
    value = r[0];
    added += r[1];
  }
  st.pos = end + 1;
  st.line += 1;
  return [value, LINE_BREAK, added];
}

// Reads a quoted field whose opening quote is at open, on the slow path:
// the segment holds a doubled quote, a newline, or a CR. Handles the
// doubled quotes and the CRLF/lone-CR-to-LF rule a character at a time,
// and the unterminated case (the quote is literal, the text after it is
// read again as unquoted). Returns [value, ended, added]; moves st.pos
// and st.line. openLine is the line the opening quote is on.
function readQuotedFrom(st, open, openLine) {
  const text = st.text;
  const n = text.length;
  let p = open + 1;
  const parts = [];
  let segStart = p;
  let closed = false;
  while (p < n) {
    const c = text.charCodeAt(p);
    if (c === 34) {
      if (text.charCodeAt(p + 1) === 34) {
        parts.push(text.slice(segStart, p));
        parts.push('"');
        p += 2;
        segStart = p;
        continue;
      }
      parts.push(text.slice(segStart, p));
      closed = true;
      p += 1;
      break;
    }
    if (c === 13) {
      // CRLF and a lone CR inside quotes are each one LF.
      parts.push(text.slice(segStart, p));
      parts.push('\n');
      st.line += 1;
      p += text.charCodeAt(p + 1) === 10 ? 2 : 1;
      segStart = p;
      continue;
    }
    if (c === 10) st.line += 1;
    p += 1;
  }
  if (!closed) {
    // The quote never closes: it is a literal character, and the text
    // after it is read again as an unquoted field.
    st.pos = open + 1;
    st.line = openLine;
    st.errors.push({ code: 'unterminated_quote', line: st.recordLine, row: st.recordRow });
    return readUnquotedFrom(st, '"');
  }
  const value = parts.join('');
  if (p >= n) {
    st.pos = n;
    return [value, END, 0];
  }
  const c = text.charCodeAt(p);
  if (c === 44) {
    st.pos = p + 1;
    return [value, COMMA, 0];
  }
  if (c === 10) {
    st.pos = p + 1;
    st.line += 1;
    return [value, LINE_BREAK, 0];
  }
  if (c === 13 && text.charCodeAt(p + 1) === 10) {
    st.pos = p + 2;
    st.line += 1;
    return [value, LINE_BREAK, 0];
  }
  // What follows the closing quote is appended as it stands, up to the
  // next comma or line break.
  st.pos = p;
  const r = readUnquotedFrom(st, value);
  if (r[2] > 0) st.errors.push({ code: 'quote_junk', line: st.recordLine, row: st.recordRow });
  return r;
}

/** csv-reader 1.0.0's answer for one case's input, computed faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Shared state for the rare-path helpers: kept in sync with the locals
  // above only around a helper call.
  const st = { text, pos: 0, line: 1, recordLine: 1, recordRow: null, errors };

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let fValue = '';
    let fEnded = END;
    let lastQuoted = false;
    do {
      if (text.charCodeAt(pos) === 34) {
        // A field that opens with a quote.
        lastQuoted = true;
        const open = pos;
        const q = text.indexOf('"', pos + 1);
        if (q === -1) {
          // No closing quote: the quote is literal, the text after it is
          // read again as unquoted. The line is still the opening quote's
          // (the search above moved nothing).
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          st.pos = open + 1;
          st.line = line;
          st.recordLine = recordLine;
          st.recordRow = recordRow;
          const r = readUnquotedFrom(st, '"');
          fValue = r[0];
          fEnded = r[1];
          pos = st.pos;
          line = st.line;
        } else if (text.charCodeAt(q + 1) === 34) {
          // The first quote found is a doubled one: slow path.
          st.pos = open;
          st.line = line;
          st.recordLine = recordLine;
          st.recordRow = recordRow;
          const r = readQuotedFrom(st, open, line);
          fValue = r[0];
          fEnded = r[1];
          pos = st.pos;
          line = st.line;
        } else {
          const seg = text.slice(open + 1, q);
          if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) {
            // A clean quoted field: no newline or CR inside it.
            const after = q + 1;
            if (after >= n) {
              fValue = seg;
              fEnded = END;
              pos = n;
            } else {
              const c = text.charCodeAt(after);
              if (c === 44) {
                fValue = seg;
                fEnded = COMMA;
                pos = after + 1;
              } else if (c === 10) {
                fValue = seg;
                fEnded = LINE_BREAK;
                pos = after + 1;
                line += 1;
              } else if (c === 13 && text.charCodeAt(after + 1) === 10) {
                fValue = seg;
                fEnded = LINE_BREAK;
                pos = after + 2;
                line += 1;
              } else {
                // Junk after the closing quote, appended as it stands.
                st.pos = after;
                st.line = line;
                st.recordLine = recordLine;
                st.recordRow = recordRow;
                const r = readUnquotedFrom(st, seg);
                fValue = r[0];
                fEnded = r[1];
                pos = st.pos;
                line = st.line;
                if (r[2] > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              }
            }
          } else {
            // A quoted field holding a newline or a CR: slow path.
            st.pos = open;
            st.line = line;
            st.recordLine = recordLine;
            st.recordRow = recordRow;
            const r = readQuotedFrom(st, open, line);
            fValue = r[0];
            fEnded = r[1];
            pos = st.pos;
            line = st.line;
          }
        }
      } else {
        // An unquoted field, on the hot path: locate its end with indexOf
        // and cut it out with slice.
        lastQuoted = false;
        const comma = text.indexOf(',', pos);
        const nl = text.indexOf('\n', pos);
        let end;
        let isComma = false;
        if (comma === -1) end = nl;
        else if (nl === -1) {
          end = comma;
          isComma = true;
        } else if (comma < nl) {
          end = comma;
          isComma = true;
        } else end = nl;

        if (end === -1) {
          // No delimiter left: the rest of the text is the field.
          if (pos < n) {
            const seg = text.slice(pos);
            if (seg.indexOf('\r') === -1) {
              fValue = seg;
            } else {
              st.pos = pos;
              st.line = line;
              st.recordLine = recordLine;
              st.recordRow = recordRow;
              const r = readUnquotedFrom(st, '');
              fValue = r[0];
              pos = st.pos;
              line = st.line;
            }
          } else fValue = '';
          pos = n;
          fEnded = END;
        } else if (isComma) {
          const seg = text.slice(pos, end);
          if (seg.indexOf('\r') === -1) {
            fValue = seg;
            pos = end + 1;
            fEnded = COMMA;
          } else {
            st.pos = pos;
            st.line = line;
            st.recordLine = recordLine;
            st.recordRow = recordRow;
            const r = readUnquotedFrom(st, '');
            fValue = r[0];
            fEnded = r[1];
            pos = st.pos;
            line = st.line;
          }
        } else {
          // The field ends at a line break: LF, or CRLF (a CR right
          // before it).
          let segEnd = end;
          if (end > pos && text.charCodeAt(end - 1) === 13) segEnd = end - 1;
          const seg = text.slice(pos, segEnd);
          if (seg.indexOf('\r') === -1) {
            fValue = seg;
            pos = end + 1;
            line += 1;
            fEnded = LINE_BREAK;
          } else {
            st.pos = pos;
            st.line = line;
            st.recordLine = recordLine;
            st.recordRow = recordRow;
            const r = readUnquotedFrom(st, '');
            fValue = r[0];
            fEnded = r[1];
            pos = st.pos;
            line = st.line;
          }
        }
      }
      fields.push(fValue);
    } while (fEnded === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
