# Supabase Database Setup

Step-by-step instructions for connecting Simple Pilot Logbook to a free Supabase PostgreSQL database.

## Prerequisites

- A [Supabase](https://supabase.com) account

## Steps

### 1. Create a new project

1. Log in to the [Supabase Dashboard](https://supabase.com/dashboard)
2. Click **New Project**
3. Choose your organisation
4. Fill in:
   - **Project name**: e.g. `pilot-logbook`
   - **Database password**: choose a strong password — **save it somewhere**, you'll need it in step 3
   - **Region**: pick the region closest to you
   - **Plan**: Free tier is fine
5. Click **Create new project** and wait for provisioning (~2 minutes)

### 2. Get the connection string

1. In your project dashboard, go to **Project Settings** (gear icon in the sidebar)
2. Click **Database** in the left menu
3. Under **Connection string**, select the **URI** tab
4. Select **Transaction pooler** mode (port `6543`) — this is the recommended mode for this app
5. Copy the connection string — it looks like:
   ```
   postgresql://postgres.[project-ref]:[YOUR-PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres
   ```

### 3. Configure the app

1. In the project root (next to `start.bat`), create a file called `.env`
   - You can copy `.env.example` as a starting point
2. Paste the connection string:
   ```
   DATABASE_URL=postgresql://postgres.[project-ref]:[YOUR-PASSWORD]@aws-0-[region].pooler.supabase.com:6543/postgres
   ```
3. Replace `[YOUR-PASSWORD]` with the database password you chose in step 1

### 4. Start the app

Run `start.bat` as usual. On first startup the app automatically creates the `flights` table — no manual SQL needed.

Visit `http://localhost:8080` — you should see an empty logbook.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `RuntimeError: DATABASE_URL is not set` | The `.env` file is missing or not in the project root directory |
| Connection refused / timeout | Check that the connection string is correct and your internet is working |
| Authentication failed | Verify the password in your `.env` matches the one you set in Supabase |
| `relation "flights" does not exist` | This shouldn't happen — `init_db()` creates it automatically. Try restarting the app. |

## Notes

- The `.env` file is git-ignored and will not be committed to version control
- If the internet is unavailable, the app will not be able to read or write flights
- The free Supabase tier pauses after 1 week of inactivity — just visit the dashboard to wake it up
