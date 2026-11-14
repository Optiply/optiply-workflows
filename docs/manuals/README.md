# The manuals

Two PDF manuals for Optiply Workflows, generated from the Markdown here:

| PDF | Made from | For |
|---|---|---|
| `Optiply-Workflows-User-Guide.pdf` | `user-guide.md` | Everyone who builds or uses workflows and apps |
| `Optiply-Workflows-Admin-Guide.pdf` | `user-guide.md` + `admin-guide.md` | Admins: everything above, plus administration and production |

The screenshots in `images/` come from a test copy of the app filled with fictional demo data; `SCREENSHOTS.md` lists
each one and what it shows.

## Keeping them up to date

When the app changes in a way users would notice:

1. **Edit the text** in `user-guide.md` (or `admin-guide.md` for admin-only matters). Reference screenshots as
   `![Caption](images/<name>.png)`, with names from `SCREENSHOTS.md`.
2. **Retake the screenshots** if screens changed (about 3 minutes, needs Docker):
   ```sh
   corepack pnpm --filter @ow/server --filter @ow/web build
   cd apps/web && npx playwright test -c playwright.manual.config.ts --reporter=line
   ```
   `SHOTS=workflow-editor,app-editor` before the command retakes only those. A new screenshot: add it to
   `SCREENSHOTS.md`, then to `apps/web/e2e-manual/manual-screenshots.spec.ts`.
3. **Rebuild the PDFs** (about 30 seconds; uses the installed Google Chrome):
   ```sh
   corepack pnpm --filter @ow/web manuals
   ```
   The script warns about any screenshot that is referenced but missing (it shows a placeholder in the PDF).
4. Commit the Markdown, the images and the two PDFs together.
