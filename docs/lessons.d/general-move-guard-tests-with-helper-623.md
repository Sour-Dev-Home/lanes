---
area: general
pattern: move-guard-tests-with-helper
severity: important
reviewer: test-hunter
source: "#623"
---

When a helper moves out of a file that is about to be deleted, move every test of it too, not only the one the new caller needs.
Moving `configuredReviewersFrom` left its fallback and owner-alias tests in `approve-guard.test.mjs`, so the guard that keeps `owner` out of the postable reviewers would have lost its tests when #616 deleted that file.
