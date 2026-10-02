# obligation-service

Obligation service for OmniCore's profession-bundle platform — deadline rules, the obligations they generate per client and period, extensions, and reminders.

Port 4010; reached through Kong at `/api/obligations`. Profession-neutral: what it
stores and how it behaves comes from the organization's installed bundle (see `bundle-sdk`).

Follows the shared service layout: `src/app.js`, `routes/`, `controllers/`, `services/`
(SQL lives there), and the copied `middleware/` (JWT + live access grants,
`requirePermission`). Schema is owned by the `migrations` repo, never by this service.

```bash
npm test && npm run lint
```
