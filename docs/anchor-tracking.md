# GiTex Anchor Tracking

This document describes the comment tracking rules and implementation in GiTex 0.11.0. Tracking locates the passage a review refers to as the LaTeX source changes. If that passage disappears, it uses the remaining evidence to estimate where it belonged.

## 1. Passage identity and estimated location

Tracking answers two separate questions: whether the original passage still exists, and whether its former location can be estimated. The result is computed for the current document, rather than stored as a permanent thread state. The persisted `resolved` state is independent of tracking.

| Result | Meaning | Display |
| --- | --- | --- |
| `attached` | The original passage or a sufficiently similar passage was found. | A normal inline comment. Approximate matches show **Similar text** and a score. |
| `uncertain` | The passage cannot be confirmed, but context supports an estimated location. This also covers saved and local references pointing to different positions. | A muted dashed marker with **Uncertain** text. A missing line can use a virtual display row. |
| `outdated` | Neither the passage nor enough evidence to estimate its location remains. | The thread stays in Explorer without a source marker. |

GiTex prefers `uncertain` when usable location evidence remains. Repeated passages, conflicting context, or an unsupported historical line number cannot establish an arbitrary location.

## 2. Stored references

An `Anchor` records the file path, base commit, document hash, source line range, and owned text. Internal line numbers are zero-based; the UI displays one-based numbers. The **Source Range** covers whole lines for the VS Code UI. The **Logical Anchor Range** identifies the text actually owned by the comment within those lines. A selection containing only blank lines cannot create an anchor.

| Field | Meaning |
| --- | --- |
| `path`, `baseCommit` | Repository-relative path and HEAD at creation time. Comments can refer to unsaved source edits, so the saved passage may differ from the committed content. |
| `documentHash` | SHA-256 of the entire document after normalizing CRLF to LF. |
| `startLine`, `endLine`, `selected` | Physical source range and owned text split into lines. The first and last entries can be partial lines. |
| `logicalRange` | Optional `{ startCharacter, endCharacter }` columns on the first and last source lines. Columns are zero-based UTF-16 offsets and the end is exclusive. Without this field the anchor owns the whole source lines. |
| `before`, `after` | Up to three immediately adjacent lines on each side, including blank lines. |
| `occurrences` | Number of exact occurrences of the selected line array when the reference was saved. |
| `sentenceContext` | One preceding and one following sentence outside the selected range. Optional for compatibility with older data. |
| `afterBoundary` | Optional `document-end` or `file-end` boundary for use when no following sentence is available. |

The same structure supports two kinds of reference:

| Reference | When it changes | Storage and sharing |
| --- | --- | --- |
| **Saved reference** | Initial comment creation, saving an attached comment edit or reply that passes the renewal policy below, or an explicit manual move. | Immutable Git review events. Previous references remain in **Tracking history** and are shared with collaborators. |
| **Local context** | Source editing while the attached passage passes the same renewal policy. | VS Code workspace storage, keyed by repository and thread. Tied to the saved reference revision and never pushed through Git. |

Unsaved source edits update only the local reference held in session memory. Saving the source persists the last reliable local reference. If the passage has since disappeared, its estimated location does not replace that reference. Source editing itself creates no shared review events and triggers no network synchronization.

### Fixed identity and renewal policy

The thread also has a fixed **identity reference**, reconstructed from its creation event or its last effective manual move. `ReviewThread.identityAnchor` is derived from existing immutable events; it is not another rolling snapshot. Automatic local updates, comment saves, synchronization, and restarts cannot reset it. Concurrent updates from an old location cannot replace the identity established by a manual move.

An Attached result is sufficient to display a comment, but not sufficient to renew its reference. `renewAnchor()` applies these rules to the logical passage:

1. Require an Attached result in the identity's file. Estimates and conflicting candidates are ineligible.
2. If the normalized logical text exactly matches the fixed identity, allow updated position and context. This includes whitespace changes, wrapping, and an unchanged passage followed by appended text.
3. Otherwise, require at least 90% direct similarity to the fixed identity, which must contain at least 16 normalized characters. This comparison uses the entire logical text, without forgiving a new suffix.
4. If the text is unchanged from the previous reference and still passes the identity check, allow a context/position refresh. If the text has changed, also require at least 90% similarity to the previous reference and strong, unchanged evidence on both sides. Evidence can come from distinctive saved sentences or corresponding distinctive adjacent lines. A matching saved end boundary can replace following context.
5. Keep the existing reference when any check fails. Comment edits and replies still save normally; only the optional reference update is omitted.

The fixed comparison prevents a series of individually plausible changes from continually replacing the original identity. For example, `A → A′ → B` cannot reset the comparison baseline by saving a reply after each step. Ordinary display attachment still uses the looser thresholds in section 4. The renewal rule is conservative text evidence, not proof of semantic equivalence or editor-operation continuity. Substantial rewrites require an explicit **Move to editor selection** to establish a new identity.

### Preserving the logical passage

Creation and manual moves currently start with the selected whole lines. Subsequent matching carries the aligned logical endpoint through to local and shared snapshots. When `A` becomes `A′ + B` on the same line, an eligible renewal stores only `A′` in `selected`, with its end column in `logicalRange`. The widget still occupies the physical source line. If renewal is not eligible, the old reference is retained; the entire `A′ + B` is never promoted merely because the line is Attached.

Normalization offsets are mapped back to the actual source columns, including tabs, repeated spaces, CRLF, Unicode, and wrapping. The bounds and cropped text are preserved by Git events and local persistence. Same-line text outside the logical range can supply preceding/following sentence context; it does not become part of the owned passage. Legacy three-line context remains physical adjacent lines.

## 3. Surrounding sentences and LaTeX handling

Each side of the selection is searched **independently**. This prevents a selected sentence without terminal punctuation from consuming its following context.

- Search up to 64 lines on each side, skipping blank lines to find the nearest sentence. A sentence wrapped across source lines is joined with spaces.
- Preserve unpunctuated fragments when a paragraph or file boundary establishes their end. Exclude fragments cut off by the search limit.
- Named LaTeX headings such as `\section*{Section Title}` can provide context. Stars, optional short titles, nested formatting, and trailing `\label` commands are supported. Heading similarity compares title content rather than shared command syntax.
- Structural commands such as `\begin`, `\end`, and `\label`, and LaTeX comments, do not establish sentence identity. Inline macros remain in the text. An escaped `\%` is distinguished from a `%` comment marker.
- Sentence extraction uses `Intl.Segmenter`; it does not execute TeX macros or interpret meaning. Each context is limited to 4,096 characters, and blocks passed to sentence segmentation are limited to 32,768 characters.

In this Korean example, selecting the `Hello` line stores `\section*{Section Title}` as preceding context and `Lalalu Lalala.` as following context. Blank lines do not prevent the following sentence from being found.

```tex
\section*{Section Title}
Hello


Lalalu
Lalala.
```

A final passage can also record `\end{document}` or the physical end of the file as a separate boundary. Blank lines, comments, closing environment commands, and labels may precede that boundary. Text after `\end{document}` is not saved as following-sentence context. An end boundary alone cannot establish a location; distinctive preceding context is also required.

## 4. Passage search and similarity

Each reference is searched in this order:

1. **Document hash match:** If the document is unchanged, use the stored range.
2. **Exact source-line match:** Find all exact candidates and distinguish them using adjacent lines and surrounding sentences. Historical line numbers alone cannot resolve repeated passages. When the original text has been copied elsewhere, also consider an edited passage whose context remains intact.
3. **Normalized and similar text:** Normalize whitespace and line wrapping, and assemble candidate ranges from consecutive lines. Shortlist candidates using character-bigram Dice scores, then compare them using bounded, order-sensitive edit distance.
4. **Context-only estimation:** If passage identity cannot be established, use surrounding context and end boundaries. A successful estimate produces Uncertain rather than Attached.

### Excluding appended text from similarity

When a candidate is longer than the reference, align the entire reference with the corresponding **prefix of the candidate**. The candidate's start is fixed, but the endpoint is searched. Internal insertions and deletions therefore do not force an incorrect cut at the original character count.

```text
Saved:    Our method improves accuracy on the evaluation dataset.
Current:  Our method improves prediction accuracy on the evaluation dataset. We also report additional measurements.
Compared: Our method improves prediction accuracy on the evaluation dataset.
Ignored:                                                                     We also report additional measurements.
```

Here, inserting `prediction` contributes to edit distance, while `We also report …` does not reduce similarity. If the original text is an unchanged prefix and only a suffix has been added, the comparison score is 1.

For normalized reference `A`, candidate `B`, and candidate prefix `B[0:k]`, the score is:

```text
score(k) = 1 - editDistance(A, B[0:k]) / max(length(A), k)
```

Choose the highest-scoring allowed endpoint `k`. On a tie, prefer the length closest to the reference length, then the earlier endpoint. This retains a substituted terminal character instead of treating it as a deletion followed by an append. Endpoints cannot split a UTF-16 surrogate pair. The appended suffix is excluded from both edit cost and the denominator. Insertions, deletions, substitutions, and leading additions within the compared prefix still contribute to edit cost. This does not select an arbitrary matching substring from the middle of a candidate. Candidates no longer than the reference retain the full-string comparison.

Length checks and Dice shortlisting also consider the prefix, so a long suffix cannot discard a candidate before alignment. Detailed comparison uses a window bounded by the reference length and an operation budget; its edit-distance matrix does not grow with the appended suffix. Document normalization and search still depend on document size.

The source range ends at the line containing the aligned endpoint. Subsequent lines containing only appended text are excluded. Appended text on the same source line remains within the whole-line UI range, but is excluded from the logical range and subsequent reference text. Short references cannot end their comparison inside a word, preventing an exact-prefix attachment of `cat` to `catalog`.

The same comparison supports fuzzy searches for distinctive **prose context** during context-only estimation. Short context still requires exact matching, and LaTeX headings retain full-title comparison.

### Attachment thresholds and computation limits

| Normalized reference length | Context score | Required similarity |
| --- | --- | --- |
| At least 16 characters | At least 0.35 | At least 0.74 |
| At least 16 characters | Below 0.35 | At least 0.86 |
| Fewer than 16 characters | At least 0.5 | At least 0.85 |
| Fewer than 16 characters | Below 0.5 | At least 0.95 |

Final candidate rank is `0.8 × similarity + 0.2 × context score`. Attachment is rejected if a candidate at a sufficiently different location trails by less than 0.06. A passage that was repeated in the saved document also requires a current context score of at least 0.35. Different appended suffixes do not, by themselves, distinguish candidates with similar prefixes.

Approximate search is limited to references of at most 12,000 characters, at most `max(12, selected line count × 2 + 6)` lines per candidate, up to 64 detailed candidate comparisons, and 8,000,000 edit-distance cell evaluations. If the operation budget is exhausted, GiTex proceeds to context estimation rather than attaching whichever candidate happened to be evaluated first. Lengths and edit distances use JavaScript string UTF-16 code units.

## 5. Context-only location estimates

When the passage cannot be found, search its saved preceding and following context independently. Context extracted from today's document is never treated as if it had been saved with the original reference.

1. Search distinctive prose context using exact and approximate matches. Approximate context requires a score of at least 0.86. Short context requires exact matches, allowing changes in terminal punctuation.
2. Require preceding context to occur before following context, with a sufficiently small gap. Gap limits depend on the original passage size and consider both character count and nonblank line count. Additional blank lines are allowed.
3. Reject candidates supported only by shared LaTeX structure, heading-only pairs, reversed context, or context separated by an excessive gap. Too many repeated matches, or a score margin below 0.08 between competing pairs, also prevent confirmation.
4. Use relative spacing recoverable from the saved three-line context to choose an estimated line between the two contexts.
5. If only one side survives, it can support a lower-confidence estimate when it is unique and distinctive and its relative spacing was saved.
6. A saved end boundary can replace following context. A missing saved `document-end` boundary is not silently replaced with the physical end of the file.

`confidence` is a heuristic for comparing candidates, not a calibrated probability of success. Results also include `estimatedLine`, an optional `estimatedRange`, and a reason. Outdated remains the fallback when the evidence is insufficient.

## 6. Combining saved and local references

Apply both the saved reference and a local reference based on its revision to the same current document. If the document returns to the exact saved document hash, that result takes precedence. This also covers undo and file restoration.

When the results indicate disjoint positions, return **two Uncertain candidates** instead of choosing one arbitrarily. Label their origins `saved` and `local`. Preserve the conflict even if one reference matches text while the other supports a different location.

Without a conflict, an Attached result from the saved reference is retained. If the saved reference is not attached, the local reference can supply an Attached result, an estimate when the saved result is Outdated, or a stronger estimate. When overlapping estimates have equal scores but different positions, prefer the recent local position.

Create a new local reference only when the final result is Attached and passes the renewal policy in section 2. A weaker attachment can remain visible without advancing the local reference. Uncertain, conflicting candidates, and Outdated never update it. A change to the saved reference revision or file path invalidates local hints based on the previous revision; the fixed identity still comes from creation or the last effective manual move.

## 7. Source display and manual reconnection

If an estimated location still contains a real blank or replacement line, mark that line. If the target line has disappeared and no line remains to mark, `insertionLine` represents the **gap before the following source line**. A value equal to the document's line count represents the gap after the final physical line.

A VS Code CodeLens displays an **Uncertain · Estimated passage** virtual row with a preview of the saved passage. This row has no source line number and changes neither file content, line count, dirty state, Git history, nor LaTeX output. Disabling `editor.codeLens` hides virtual rows while retaining inline reviews. At the physical end of a file without a following line, the CodeLens appears above the last line with **After final line**, and the comment widget sits below that line.

Two candidates still share one comment thread, draft, history, and Review tab. Their markers and the **Open saved candidate** and **Open local candidate** buttons navigate to different locations for the same thread. Clicking or expanding an estimate never saves it as a new anchor.

Select the intended source lines and use **Move to editor selection** to record an explicit new reference. The move event retains the previous reference, new reference, author, and timestamp. Resolving a thread hides all its source markers while preserving Explorer access and history. Reopening restores markers according to the current tracking result.

## 8. Saving, history, and compatibility

Saving a comment edit or reply while Attached renews the shared reference only if the strict renewal policy passes. An eligible update captures the logical passage and its bounds, physical source range, surrounding context, end boundary, and document hash in the same immutable review event. This may include unsaved source edits. A weaker attachment saves the comment body while retaining the previous reference. Failed saves and saves based on stale revisions cannot change the shared reference.

Saving a comment while Uncertain or Outdated preserves the previous shared reference. A new shared reference requires an explicit move, or a comment save after the passage becomes eligible for renewal. When enabled, automatic pull + push runs after saving a comment, reply, edit, or manual move; viewing reviews and editing source alone do not trigger it.

The event format remains version 1. Older data without `sentenceContext` or `afterBoundary` uses its saved adjacent lines. Empty sentence fields also fall back to available saved line context. A document terminator already present in legacy `after` lines can provide boundary evidence. Context that was never saved cannot be reconstructed from the current document and claimed as historical evidence.

Opening or synchronizing reviews does not rewrite existing events. The next eligible comment save or manual move adds an improved shared reference while retaining the previous one in history. `logicalRange` is optional and validated when present; older anchors without it retain whole-line semantics. The fixed identity is reconstructed even for legacy histories, without changing their events. Already expanded or drifted references are not silently rewritten; use a manual move to confirm a new target when necessary.

The event format remains version 1, so older clients can read the additional field, but they cannot enforce its logical bounds or the new renewal policy. All collaborators should use **GiTex 0.11.0 or later** to preserve these protections when saving comments. Local persistence also keeps the optional bounds without a storage migration.

## 9. Implementation and verification

| File | Responsibility |
| --- | --- |
| [`src/anchor.ts`](../src/anchor.ts) | Anchor creation, logical/source range mapping, strict renewal policy, sentence extraction, exact and approximate search, appended-suffix exclusion, and context-only estimates. |
| [`src/localTracking.ts`](../src/localTracking.ts) | Combining saved and local results, retaining both candidates, updating local references, and preparing persisted state. |
| [`src/extension.ts`](../src/extension.ts) | Connecting tracking to live documents, refreshing references on saves, source/Explorer/CodeLens display, and manual moves. |
| [`src/model.ts`](../src/model.ts), [`src/store.ts`](../src/store.ts) | Data validation, immutable review events, reference and history reconstruction, and Git sharing. |
| [`test/anchor.test.ts`](../test/anchor.test.ts) | Long appended text, internal edits, Korean and LaTeX text, wrapping, duplicate and false-match protection, context, and end boundaries. |
| [`test/localTracking.test.ts`](../test/localTracking.test.ts) | Local updates, recovery after deletion, conflicting candidates, persistence and restart, and shared reference preservation. |
| [`test/renewal.test.ts`](../test/renewal.test.ts) | Cumulative drift prevention, logical prefix retention, stricter renewal evidence, raw column mapping, and persisted bounds. |
| [`test/host/anchorProtection.ts`](../test/host/anchorProtection.ts) | Logical ranges and fixed identity through native replies/edits, panel saves, and explicit manual moves. |
| [`test/host/`](../test/host/) | Display, navigation, draft preservation, moves, and synchronization in an actual VS Code instance. |

Run `make test` for core regression tests and `make test-extension` for VS Code integration tests. Linux UI tests require a display or Xvfb. Text comparison does not replace semantic understanding or LaTeX parsing; add real editing cases as regression tests when refining thresholds and boundary handling.
