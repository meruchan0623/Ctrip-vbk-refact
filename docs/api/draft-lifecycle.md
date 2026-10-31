# Suggested repository note: docs/api/draft-lifecycle.md

The draft cache is in-memory, per gid, and belongs only to the active account scope. Opening a room uses the cached string first, including an intentionally empty string; only uncached rooms fall back to the conversation draft field. Conversation previews read the same cache. No draft-save RPC or persistence guarantee is introduced.

Submitting text clears only that room's cached draft at submission. A receipt, unknown result or error does not subsequently clear a different room or a newer draft. An unknown result is never automatically resent or restored into the editor. The local message remains the appropriate place to inspect the attempted text. Attachment fail-closed behavior continues to preserve the editor and attachment.

An account, environment or generation change resets the current editor and all cached drafts; same-scope account readback leaves them intact. This change does not claim to preserve drafts across account switches, logout, restart or crash.

Translation results already check the captured account/environment/generation, gid and draft version before applying. Rendered translation actions must independently revalidate the captured scope, primitive draft version and exact translation object. This prevents a detached old button from replacing or sending another room's text, including after a language/translation refresh. Error fallback, retry and language controls have the same guard.

Evidence: drafts-scope.test.ts executes actual main setDraft/openConversation/handleSend/sendText/translateAndSend/runPreviewTranslation/translationBar/applyAccountSnapshot functions with the real immutable createStore implementation and synthetic fixtures. Twelve cases cover the full behavior; before-main with the same final fixture produced five real failures, after-main is 12/12. Pure HEAD cf0909c plus the complete drafts patch also passes 12/12 and typecheck. No browser, network request or production send was performed.

Integration note: drafts-ui-full.patch is based on cf0909c and excludes media/history/unknown/vendor/time hunks. Its openConversation draft line is adjacent to the independently patched history page request, so applying after history may need a context rebase. drafts-ui-full-zero-context.patch contains the same changes with zero context for exact staging when appropriate; inspect it and use --unidiff-zero only intentionally. Both versions are full draft blocks, not just the translation guard fix.

## Windows request ownership correction (2026-10-31)

Account/room/draft checks alone do not distinguish two translations of the same draft. Preview and direct-send translation now capture their exact busy-state object; both success and failure may proceed only while that object still owns the active request. Changing language, including changing away and back, invalidates the old request without relying on the text version. A newer request for the same language also supersedes the previous one. Existing detached-button ownership checks remain in force.

The original twelve regressions remain. Four additional tests exercise actual language controls and preview/direct handlers, including overlapping completions, old errors and language ABA. Before the fix: 13 passed / 3 failed; with the fix: 16 passed / 0 failed. Removing the request guard in a temporary source copy reproduces the three failures; restoring the real implementation passes all sixteen. Independent read-only review passed another 24 interleavings. This is synthetic offline verification, not online translation or message-delivery acceptance.
