# VC Record

Minimal interview practice based on [iPG](https://jamescun.github.io/iPG/): all 77 original questions and 7 tips, with 15-second camera/microphone recordings and free on-device transcription.

**App:** https://akhilvemuri26.github.io/vcrecord/

## Use

1. Enter your name, select **Record answer**, and allow camera/microphone access.
2. Answer for up to 15 seconds, or choose **Stop & save**.
3. Open **Answers** to play recordings, edit/download transcripts, and group by question or person.

Video and audio save in this browser's IndexedDB before transcription begins. Whisper downloads its model on first use, which can take a few minutes; speech is processed on your device. Failed transcription can be retried without recording again.

Recordings are browser-local. Clearing site data can erase them; download important recordings and transcripts. The question/person views currently show only this browser's answers. Automatic sharing between cofounders is not yet configured.

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
