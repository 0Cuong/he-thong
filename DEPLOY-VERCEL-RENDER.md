# Deploy Classroom 48 (Vercel + Render)

## 1) Backend on Render
- Create a Render Blueprint using this repository and the `render.yaml` file.
- Set `FRONTEND_URL` to your Vercel production URL (for example https://your-app.vercel.app).
- Render generates `SESSION_SECRET`; keep it private.
- A persistent disk is mounted at `/var/data` for SQLite data.

## 2) Frontend on Vercel
- Import this repository into Vercel.
- Set Root Directory to the repository root.
- Add environment variable `VITE_API_BASE_URL` with the Render service URL (no trailing slash).
- Deploy the branch `deploy-vercel-render`.

## 3) Final connection
- After Vercel URL is known, set Render `FRONTEND_URL` to that exact URL and redeploy.
- Both services must use HTTPS.
- WebSocket traffic is handled by the Render backend.

## Notes
- This branch is a deployment adaptation; merge it into main only after testing.
- SQLite data requires Render persistent disk. Disk availability/pricing depends on Render plan.
- Vercel deploy previews use different origins and are not automatically allowed by this CORS configuration.
