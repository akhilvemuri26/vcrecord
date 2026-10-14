# VC Record

Minimal interview practice based on [iPG](https://jamescun.github.io/iPG/): all 77 original questions and 7 tips, with 15-second camera/microphone recordings and free on-device transcription.

**App:** https://akhilvemuri26.github.io/vcrecord/

## Use

1. Enter your name, select **Record answer**, and allow camera/microphone access.
2. Answer for up to 15 seconds, or choose **Stop & save**.
3. Open **Answers** to play recordings, edit/download transcripts, and group by question or person.

Video and audio save in this browser's IndexedDB before transcription begins. Whisper downloads its model on first use, which can take a few minutes; speech is processed on your device. Failed transcription can be retried without recording again.

Open your private cofounder invitation and enter your name. New answers automatically upload their videos and transcripts to your shared Supabase team, grouped by question, person (case-insensitive name), or recency. You can also create a team and copy its invitation. **Share saved answers** explicitly uploads existing local recordings; opening an invite never silently shares them. **Refresh / retry sync** retries failed uploads, transcript edits, and deletions. Local video remains available when a network request fails.

Anyone given the private invitation can join. Team members can read recordings; only the recording's browser identity can edit or delete it. Anonymous sessions persist in browser storage. Clearing site/auth data loses that editing identity: reopening the invite restores team reading and new recording access, but cannot recover ownership of old answers. Download important recordings and transcripts. Supabase stores videos in a private bucket; transcription stays on device.

Practice chooses a random question each time, excluding the question currently shown, and continues indefinitely.

Chrome/Chromium was tested. Other browsers need MediaRecorder, AudioWorklet, IndexedDB, and WebAssembly support. Camera access requires HTTPS or localhost.

## Development

Use Node 22.23.0 (`nvm use`), then:

```sh
npm ci
npm run dev
npm test
npm run build
```

Stop the development server when finished. GitHub Actions builds and deploys `dist/` to Pages on pushes to `main`.

## Source and review

Question wording and tips come from James Cunningham and Colin Hayhurst's iPG. The original source, SHA256, and retrieval details are in `upstream/`. Source parity is tested. No license is asserted for the upstream material.

See `plan.html`, `handoff.html`, and `review.html` for implementation and validation details. Recordings, transcripts, generated build files, and browser-test artifacts are not committed.

## Shared backend

The reproducible schema and private-storage policies are in `supabase/migrations/20261014000000_sharing.sql`. The browser uses the project URL and publishable key in `src/sharing.ts`; no server secret is bundled. Anonymous auth is enabled on the configured Supabase project. Invitations use a 32-byte random secret in the URL fragment, cleared immediately on arrival; the database stores its hash.
