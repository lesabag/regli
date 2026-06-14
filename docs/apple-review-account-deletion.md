# Apple Review Readiness

Regli exposes post-signup legal and deletion access from authenticated settings screens:

- `Settings -> Legal -> Terms of Service`
- `Settings -> Legal -> Privacy Policy`
- `Settings -> Account -> Delete Account`

The delete-account flow requires an explicit confirmation step before execution.

On success:

- the authenticated user is deleted through the `delete-account` Supabase Edge Function
- profile data is anonymized where historical financial or booking records must remain
- push tokens and user-owned preference rows are removed
- the app signs the user out and returns to the auth screen

This entry point is available for both client and provider accounts for Apple review.
