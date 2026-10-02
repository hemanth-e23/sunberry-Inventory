// Receipt notes carry review tags appended by the server
// (backend/app/services/receipt_service.py):
//   "[Sent Back by <reviewer name>]: <instructions>"
//   "[Rejected by <reviewer name>]: <reason>"
// The reviewer is the user's NAME, never the literal word "Supervisor" — the
// corrections page used to match only "[Sent Back by Supervisor]:" and so never
// showed the instructions. These helpers split a note into the worker's own text
// and the review entries so screens can show each in its place.

const TAG_RE = /^\s*\[(Sent Back|Rejected) by ([^\]]*)\]:\s*(.*)$/;

// -> { text, reviews: [{ action: 'sent_back' | 'rejected', by, text }] }
// Lines after a tag (a multi-line reason) belong to that tag until the next one.
export const parseReceiptNote = (note) => {
  const own = [];
  const reviews = [];
  String(note || '').split('\n').forEach((line) => {
    const m = line.match(TAG_RE);
    if (m) {
      reviews.push({
        action: m[1] === 'Sent Back' ? 'sent_back' : 'rejected',
        by: m[2].trim(),
        text: m[3].trim(),
      });
    } else if (reviews.length) {
      const last = reviews[reviews.length - 1];
      last.text = last.text ? `${last.text}\n${line}`.trim() : line.trim();
    } else {
      own.push(line);
    }
  });
  return { text: own.join('\n').trim(), reviews };
};

export const hasSendBackTag = (note) =>
  parseReceiptNote(note).reviews.some((r) => r.action === 'sent_back');

// The most recent send-back (the one the worker is fixing now), or null.
export const latestSendBack = (note) => {
  const sent = parseReceiptNote(note).reviews.filter((r) => r.action === 'sent_back');
  return sent.length ? sent[sent.length - 1] : null;
};

// The worker's own note with review tags removed (for list/table display).
export const stripReviewTags = (note) => parseReceiptNote(note).text;

// Put an edited worker note back in front of the review tags so the server-side
// history survives a Save & Resubmit.
export const composeReceiptNote = (ownText, originalNote) => {
  const { reviews } = parseReceiptNote(originalNote);
  const tags = reviews.map(
    (r) => `[${r.action === 'sent_back' ? 'Sent Back' : 'Rejected'} by ${r.by}]: ${r.text}`
  );
  return [String(ownText || '').trim(), ...tags].filter(Boolean).join('\n');
};
