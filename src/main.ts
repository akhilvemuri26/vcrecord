import "@fontsource/lato/latin-400.css";
import "@fontsource/lato/latin-700.css";
import "./style.css";
import { questions, tips } from "./questions";
import { startCapture, startMediaTest } from "./capture";
import { analyzeAudio, EMPTY_TRANSCRIPT_MESSAGE } from "./audio-analysis";
import { readTiming, validTiming } from "./timing";
import { listAnswers, listSyncRecords, getAnswer, saveAnswer, updateAnswer, type Answer } from "./storage";
import * as sharing from "./sharing";
import { drainSync, assignTeam, markDeleted, queueRemoteEdit, queueRemoteDelete } from "./sync";
import { projectLibrary, normalizePerson as personKey, personName as displayPerson, personOptions, filterLibrary, selectLibraryAnswer, ALL_PEOPLE, type LibraryAnswer } from "./library";
function captureInvitation() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (!fragment.has("team") || !fragment.has("invite")) return false;
    try { localStorage.setItem("vcrecord-pending-invite", JSON.stringify({ id: fragment.get("team"), invite: fragment.get("invite") })); } catch {}
    history.replaceState(null, "", location.pathname + location.search);
    return true;
}
captureInvitation();
const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Invite = { id: string; invite: string };
function readTeam(value: string | null): { id: string; invite?: string } | undefined {
    try { const parsed = JSON.parse(value ?? "null"); if (parsed && typeof parsed.id === "string" && uuid.test(parsed.id) && (parsed.invite === undefined || (typeof parsed.invite === "string" && /^[0-9a-f]{64}$/i.test(parsed.invite)))) return parsed; } catch {}
}
let team = readTeam(stored("vcrecord-team"));
let invitation = readTeam(stored("vcrecord-invitation")) as Invite | undefined;
if (!invitation?.invite && team?.invite) invitation = { id: team.id, invite: team.invite };
let accessibleTeams: string[] = [], confirmedUser: string | null = null, connectionGeneration = 0;
let connecting = false;
let remoteAnswers: sharing.RemoteAnswer[] = [];
let remoteRefresh = 0, libraryRender = 0;
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header><strong>VC Record</strong><nav aria-label="Main"><button id="practice-nav">Practice</button><button id="answers-nav">Answers</button></nav></header><main><div class="team-controls"><strong>Cofounders · Akhil, Prakrit, Aarav</strong><button id="copy-invite" hidden>Copy invite</button><button id="refresh-team" hidden>Refresh / retry sync</button><button id="share-saved" hidden>Share saved answers</button><span id="team-status" role="status"></span></div><section id="practice"><h1 id="question" hidden></h1><p id="phase" class="position">Ready to practice</p><div class="timer" id="timer" aria-label="Seconds remaining" hidden>15</div><video id="preview" autoplay muted playsinline hidden aria-label="Camera preview"></video><p class="person-field"><label for="person">Answering as </label><select id="person"><option value="">Choose a person</option><option>Akhil</option><option>Prakrit</option><option>Aarav</option></select></p><div class="actions"><button id="record" class="primary">Start practice</button><button id="test-media">Test mic &amp; video</button><button id="cancel" hidden>Cancel</button><button id="stop" hidden>Stop &amp; save</button><button id="next">Next question</button></div><section id="media-test" class="media-test" aria-labelledby="media-test-title" hidden><h2 id="media-test-title" tabindex="-1">Test mic &amp; video</h2><p id="media-test-status" role="status" aria-live="polite"></p><video id="media-test-preview" muted playsinline aria-label="Test camera preview" hidden></video><div id="media-test-level" hidden><label for="media-test-meter">Microphone audio level</label><meter id="media-test-meter" min="0" max="1" value="0"></meter><span id="media-test-countdown" aria-hidden="true"></span></div><video id="media-test-player" controls playsinline aria-label="Test recording playback" hidden></video><p class="position">Test only — not saved or shared.</p><div class="actions"><button id="media-test-again" hidden>Try again</button><button id="media-test-close">Cancel</button></div></section><p id="status" class="status" role="status" aria-live="polite"></p><div class="actions" id="rescue" hidden><button id="rescue-download">Download unsaved recording</button><button id="rescue-retry">Retry saving</button></div><details id="timing-settings"><summary>Timing settings</summary><form id="timing-form" novalidate><label for="prep-seconds">Preparation seconds</label><input id="prep-seconds" type="number" min="1" max="120" step="1" required><label for="answer-seconds">Answer seconds</label><input id="answer-seconds" type="number" min="5" max="30" step="1" required><button>Save timing</button><p id="timing-error" role="status"></p></form></details><p id="timing-summary" class="position"></p><p id="tip" class="tip" hidden></p></section><section class="library" id="library" hidden><h1>Answers</h1><p><span id="library-context">Answers saved in this browser.</span></p><div class="library-filters"><label for="person-filter">Person <select id="person-filter"><option value="*">All people</option><option value="akhil">Akhil</option><option value="prakrit">Prakrit</option><option value="aarav">Aarav</option></select></label><label for="group-by">View <select id="group-by"><option value="recent">Most recent</option><option value="question">By question</option></select></label><span id="library-count" role="status"></span></div><p id="library-status" role="status"></p><div class="library-layout"><ul class="answer-list" id="answer-list"></ul><div class="detail" id="detail"></div></div></section></main>`;
const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let owner: {
    id: string;
    name: string;
} = { id: crypto.randomUUID(), name: "" };
try {
    const saved = localStorage.getItem("vcrecord-owner");
    if (saved) {
        const parsed = JSON.parse(saved);
        if (parsed && typeof parsed.id === "string" && typeof parsed.name === "string")
            owner = parsed;
    }
}
catch {
}
el<HTMLSelectElement>("person").value = ["Akhil", "Prakrit", "Aarav"].find(name => personKey(owner.name) === name.toLowerCase()) ?? "";
function saveOwner() {
    owner.name = el<HTMLInputElement>("person").value.trim();
    try {
        localStorage.setItem("vcrecord-owner", JSON.stringify(owner));
    }
    catch {
    }
}
el("person").onchange = saveOwner;
const personName = (answer: LibraryAnswer) => displayPerson(answer.person);
const isLocal = (answer: LibraryAnswer): answer is Answer => "video" in answer;
const mayEdit = (answer: LibraryAnswer) => !answer.ownerId || answer.ownerId === sharing.getUserId();
el("group-by").onchange = () => void renderLibrary();
el("person-filter").onchange = () => void renderLibrary();
const status = (message: string) => {
    el("status").textContent = message;
};
let timing = readTiming(stored("vcrecord-timing"));
type Phase = "idle" | "setup" | "preparing" | "recording" | "saving";
let phase: Phase = "idle", generation = 0, attemptAbort: AbortController | undefined;
let currentQuestion = questions[Math.floor(Math.random() * questions.length)], busy = false, capture: {
    stop: () => void;
} | undefined, unsaved: Answer | undefined;
let selectedId: string | undefined, playbackURL: string | undefined, worker: Worker | undefined, activeJob: string | undefined;
const jobs: string[] = [];
let progress = "";
let testGeneration = 0, testAbort: AbortController | undefined, testURL: string | undefined;
function closeMediaTest(returnFocus = false) {
    testGeneration++;
    const abort = testAbort; testAbort = undefined; abort?.abort();
    const player = el<HTMLVideoElement>("media-test-player");
    player.pause(); player.removeAttribute("src"); player.load();
    if (testURL) URL.revokeObjectURL(testURL);
    testURL = undefined;
    el("media-test").hidden = true;
    el<HTMLMeterElement>("media-test-meter").value = 0;
    if (returnFocus) el("test-media").focus();
}
async function beginMediaTest() {
    if (phase !== "idle" || unsaved || document.visibilityState === "hidden") return;
    closeMediaTest();
    const token = testGeneration;
    const abort = new AbortController(); testAbort = abort;
    const current = () => token === testGeneration && !abort.signal.aborted;
    el("media-test").hidden = false;
    el("media-test-preview").hidden = false;
    el("media-test-player").hidden = true;
    el("media-test-level").hidden = true;
    el("media-test-again").hidden = true;
    el("media-test-close").textContent = "Cancel";
    el("media-test-status").textContent = "Getting camera and microphone ready…";
    el("media-test-title").focus();
    try {
        const handle = await startMediaTest(el("media-test-preview"), remaining => {
            if (current()) el("media-test-countdown").textContent = `${remaining}s remaining`;
        }, result => {
            if (!current()) return;
            testAbort = undefined;
            el("media-test-preview").hidden = true;
            el("media-test-level").hidden = true;
            testURL = URL.createObjectURL(result.video);
            const player = el<HTMLVideoElement>("media-test-player");
            player.src = testURL; player.muted = false; player.hidden = false;
            const analysis = analyzeAudio(result.audio);
            el("media-test-status").textContent = analysis.message + (analysis.kind === "captured" && analysis.rms < 0.00001
                ? " Input level is very low; check microphone selection and hardware mute if you cannot hear your voice." : "");
            el("media-test-again").hidden = false;
            el("media-test-close").textContent = "Close";
        }, error => {
            if (!current()) return;
            testAbort = undefined;
            el("media-test-preview").hidden = true;
            el("media-test-level").hidden = true;
            el("media-test-status").textContent = "Could not test camera and microphone: " + error.message;
            el("media-test-again").hidden = false;
            el("media-test-close").textContent = "Close";
        }, {
            signal: abort.signal,
            onPhase: () => {
                if (!current()) return;
                el("media-test-status").textContent = "Speak for five seconds.";
                el("media-test-level").hidden = false;
            },
            onAudioLevel: level => { if (current()) el<HTMLMeterElement>("media-test-meter").value = Math.min(1, level * 8); },
            onCancelled: () => { if (current()) closeMediaTest(true); },
        });
        if (!current()) handle.stop();
    } catch (error) {
        if (!current()) return;
        testAbort = undefined;
        el("media-test-preview").hidden = true;
        el("media-test-status").textContent = "Could not test camera and microphone: " + (error instanceof Error ? error.message : String(error));
        el("media-test-again").hidden = false;
        el("media-test-close").textContent = "Close";
    }
}
el("test-media").onclick = () => void beginMediaTest();
el("media-test-again").onclick = () => void beginMediaTest();
el("media-test-close").onclick = () => closeMediaTest(true);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") closeMediaTest(); });
window.addEventListener("pagehide", () => closeMediaTest());
let jobTimer: ReturnType<typeof setTimeout> | undefined;
function question(reveal = false) {
    el("question").textContent = currentQuestion.text;
    el("question").hidden = !reveal;
    el("tip").hidden = !reveal;
    el("tip").textContent = "ProTip: " + tips[Math.floor(Math.random() * tips.length)];
    el("timer").textContent = String(timing.preparationSeconds);
    el("timer").className = "timer";
}
function timingSummary() {
    el<HTMLInputElement>("prep-seconds").value = String(timing.preparationSeconds);
    el<HTMLInputElement>("answer-seconds").value = String(timing.answerSeconds);
    el("timing-summary").textContent = `${timing.preparationSeconds}s to prepare · ${timing.answerSeconds}s to answer · Recording starts automatically`;
}
function controls() {
    const locked = phase === "recording" || phase === "saving";
    busy = phase !== "idle";
    el<HTMLButtonElement>("record").disabled = busy || !!unsaved;
    el<HTMLButtonElement>("test-media").disabled = busy || !!unsaved;
    el<HTMLInputElement>("person").disabled = busy || !!unsaved;
    el<HTMLButtonElement>("next").disabled = locked || !!unsaved;
    el<HTMLButtonElement>("answers-nav").disabled = locked;
    el<HTMLButtonElement>("practice-nav").disabled = locked;
    for (const id of ["prep-seconds", "answer-seconds"]) el<HTMLInputElement>(id).disabled = locked;
    el<HTMLButtonElement>("timing-form").querySelector("button")!.disabled = locked;
    el("stop").hidden = phase !== "recording";
    el("cancel").hidden = phase !== "setup" && phase !== "preparing";
    el("record").hidden = busy;
    el("timer").hidden = phase === "idle" || phase === "setup";
    el("phase").textContent = phase === "preparing" ? "Prepare" : phase === "recording" ? "Answer" : phase === "setup" ? "Setting up camera and microphone" : phase === "saving" ? "Saving answer" : "Ready to practice";
}
function cancelAttempt(message = "Practice cancelled. Start practice when you are ready.") {
    if (phase !== "setup" && phase !== "preparing") return;
    generation++;
    attemptAbort?.abort();
    attemptAbort = undefined;
    capture = undefined;
    phase = "idle";
    el("preview").hidden = true;
    el("record").textContent = "Start practice";
    controls(); status(message);
}
el("cancel").onclick = () => cancelAttempt();
el<HTMLDetailsElement>("timing-settings").ontoggle = () => {
    if (el<HTMLDetailsElement>("timing-settings").open) cancelAttempt("Timing opened. Start practice after choosing your timing.");
};
el("timing-form").onsubmit = event => {
    event.preventDefault();
    if (phase === "recording" || phase === "saving") return;
    cancelAttempt();
    const proposed = { preparationSeconds: Number(el<HTMLInputElement>("prep-seconds").value), answerSeconds: Number(el<HTMLInputElement>("answer-seconds").value) };
    if (!validTiming(proposed)) {
        el("timing-error").textContent = "Use whole seconds: preparation 1–120, answer 5–30.";
        return;
    }
    timing = proposed;
    try { localStorage.setItem("vcrecord-timing", JSON.stringify(timing)); el("timing-error").textContent = "Timing saved for this browser."; }
    catch { el("timing-error").textContent = "Timing changed for this visit. Browser storage is unavailable."; }
    timingSummary();
};
for (const id of ["prep-seconds", "answer-seconds"]) el(id).oninput = () => cancelAttempt("Timing changed. Save timing, then start practice.");
function download(answer: Answer) {
    const url = URL.createObjectURL(answer.video);
    const a = document.createElement("a");
    a.href = url;
    a.download = `answer-${new Date(answer.createdAt).toISOString().replaceAll(":", "-")}.${answer.mime.includes("mp4") ? "mp4" : "webm"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function persist(answer: Answer) {
    try {
        await saveAnswer(answer);
        unsaved = undefined;
        el("rescue").hidden = true;
        status("Answer saved. Transcribing on your device\u2026");
        el("record").textContent = "Practice again";
        enqueue(answer.id);
        void syncAndRefresh();
    }
    catch (error) {
        unsaved = answer;
        el("rescue").hidden = false;
        status("Recording could not be saved in browser storage. Download it now, or retry saving. " + String(error));
    }
}
el("rescue-download").onclick = () => {
    if (unsaved) {
        download(unsaved);
        status("Download started. Keep this answer until you confirm the file is saved.");
    }
};
const discard = document.createElement("button");
discard.textContent = "Discard unsaved answer";
discard.onclick = () => {
    if (confirm("Discard this unsaved answer? Make sure you downloaded it first.")) {
        unsaved = undefined;
        el("rescue").hidden = true;
        status("Unsaved answer discarded.");
        controls();
    }
};
el("rescue").append(discard);
el("rescue-retry").onclick = async () => {
    if (!unsaved || phase !== "idle") return;
    phase = "saving"; controls(); await persist(unsaved); phase = "idle"; controls();
};
async function beginAttempt() {
    if (phase !== "idle" || document.visibilityState === "hidden" || el("practice").hidden) return;
    if (unsaved) { status("Save the unsaved answer, or download and discard it before practicing again."); return; }
    closeMediaTest();
    saveOwner();
    if (!owner.name) { status("Choose a person, then start practice."); el("person").focus(); return; }
    el<HTMLDetailsElement>("timing-settings").open = false;
    const token = ++generation;
    const abort = new AbortController(); attemptAbort = abort;
    const current = () => token === generation;
    const frozen = { ...currentQuestion }, selectedTiming = { ...timing };
    const person = owner.name, personId = owner.id;
    const assignedOwner = sharing.getUserId();
    const assignedTeam = !connecting && assignedOwner === confirmedUser && accessibleTeams.includes(team?.id ?? "") ? team?.id : undefined;
    phase = "setup"; question();
    el<HTMLButtonElement>("stop").disabled = false;
    el("preview").hidden = false; controls();
    status("Getting camera and microphone ready… Your preparation timer starts when the question appears.");
    try {
        const handle = await startCapture(el("preview"), remaining => {
            if (!current()) return;
            el("timer").textContent = String(remaining);
            el("timer").className = "timer" + (remaining <= 0 ? " end" : remaining <= 5 ? " warn" : "");
        }, async result => {
            if (!current() || phase === "saving" || phase === "idle") return;
            phase = "saving"; capture = undefined; attemptAbort = undefined;
            el("preview").hidden = true; controls(); status("Saving answer…");
            const answer: Answer = { id: crypto.randomUUID(), questionId: frozen.id, person, personId, question: frozen.text, createdAt: Date.now(), ...result, transcript: "", status: "pending", ...(assignedTeam && assignedOwner ? {teamId: assignedTeam, ownerId: assignedOwner, revision: 1, syncState: "pending" as const} : {}) };
            await persist(answer);
            if (!current()) return;
            phase = "idle"; controls();
        }, error => {
            if (!current()) return;
            generation++; capture = undefined; attemptAbort = undefined; phase = "idle";
            el("preview").hidden = true; controls(); status("Recording failed: " + error.message);
        }, {
            ...selectedTiming, signal: abort.signal,
            onPhase: nextPhase => {
                if (!current()) return;
                phase = nextPhase;
                if (nextPhase === "preparing") { question(true); status("Prepare your answer. Recording starts automatically at zero."); }
                else status(`Recording… You have ${selectedTiming.answerSeconds} seconds to answer.`);
                controls();
            },
            onCancelled: () => { if (current()) cancelAttempt(); },
        });
        if (!current() || abort.signal.aborted) { handle.stop(); return; }
        capture = handle;
        navigator.storage?.persist?.().catch(() => {});
    } catch (error) {
        if (!current()) return;
        generation++; phase = "idle"; capture = undefined; attemptAbort = undefined;
        el("preview").hidden = true; controls();
        status("Could not start practice: " + (error instanceof Error ? error.message : String(error)) + " Try Start practice again.");
    }
}
el("record").onclick = () => void beginAttempt();
el("stop").onclick = () => { capture?.stop(); el<HTMLButtonElement>("stop").disabled = true; };
el("next").onclick = () => {
    if (phase === "recording" || phase === "saving" || unsaved) return;
    closeMediaTest();
    cancelAttempt();
    const choices = questions.filter(q => q.id !== currentQuestion.id);
    currentQuestion = choices[Math.floor(Math.random() * choices.length)];
    question(); void beginAttempt();
};
function practice() {
    if (phase === "recording" || phase === "saving") return;
    closeMediaTest();
    el("practice").hidden = false;
    el("library").hidden = true;
    if (playbackURL) {
        URL.revokeObjectURL(playbackURL);
        playbackURL = undefined;
        el("detail").dataset.answerId = "";
    }
    el<HTMLVideoElement>("detail").querySelector("video")?.pause();
}
el("practice-nav").onclick = practice;
el("answers-nav").onclick = () => {
    if (phase === "recording" || phase === "saving") return;
    closeMediaTest();
    cancelAttempt();
    el("practice").hidden = true;
    el("library").hidden = false;
    void renderLibrary();
    void refreshLibraryConnection().then(() => renderLibrary());
};
function queueWorker() {
    if (worker)
        return worker;
    worker = new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = async (event) => {
        const msg = event.data;
        if (msg.status === "progress") {
            progress = msg.message;
            if (!busy && el("media-test").hidden)
                status(progress);
            if (selectedId === msg.id)
                el("library-status").textContent = progress;
            return;
        }
        try {
            await updateAnswer(msg.id, answer => {
                answer.status = msg.status;
                answer.transcriptError = msg.error;
                if (!answer.edited)
                    answer.transcript = msg.text ?? "";
            });
            void syncAndRefresh();
            if (!busy && el("media-test").hidden)
                status(msg.status === "done" ? "Transcript ready in Answers." : msg.status === "silent" ? ("Answer saved. " + (msg.error ?? EMPTY_TRANSCRIPT_MESSAGE)) : "Answer saved. Transcription failed; retry in Answers.");
            if (!el("library").hidden)
                await renderLibrary();
        }
        catch (error) {
            if (!busy && el("media-test").hidden) status("Recording remains saved, but transcript could not be saved: " + String(error));
        }
        finally {
            void syncAndRefresh();
            activeJob = undefined;
            clearTimeout(jobTimer);
            progress = "";
            if (!el("library").hidden)
                await renderLibrary();
            void runQueue();
        }
    };
    worker.onerror = async () => {
        clearTimeout(jobTimer);
        const id = activeJob;
        worker?.terminate();
        worker = undefined;
        activeJob = undefined;
        if (id) {
            await updateAnswer(id, answer => {
                answer.status = "error";
                answer.transcriptError = "Speech worker could not start. Retry transcription.";
            });
        }
        void syncAndRefresh();
        if (!busy && el("media-test").hidden) status("Recording saved. Speech worker could not start; retry in Answers.");
        if (!el("library").hidden)
            await renderLibrary();
        void runQueue();
    };
    return worker;
}
function enqueue(id: string) {
    if (id !== activeJob && !jobs.includes(id))
        jobs.push(id);
    void runQueue();
}
async function runQueue() {
    if (activeJob || !jobs.length)
        return;
    const id = jobs.shift()!;
    activeJob = id;
    try {
        const answer = await getAnswer(id);
        if (!answer || answer.deletedAt) {
            activeJob = undefined;
            void runQueue();
            return;
        }
        const exists = await updateAnswer(id, current => {
            current.status = "working";
        });
        if (!exists) {
            activeJob = undefined;
            void runQueue();
            return;
        }
        void syncAndRefresh();
        queueWorker().postMessage({ id, audio: answer.audio });
        jobTimer = setTimeout(async () => {
            worker?.terminate();
            worker = undefined;
            activeJob = undefined;
            await updateAnswer(id, current => {
                current.status = "error";
                current.transcriptError = "Speech model download or transcription timed out. Check your connection and retry.";
            }).catch(() => {
            });
            void syncAndRefresh();
            if (!busy && el("media-test").hidden)
                status("Recording saved. Transcription timed out; retry in Answers.");
            if (!el("library").hidden)
                await renderLibrary();
            void runQueue();
        }, 180000);
    }
    catch (error) {
        activeJob = undefined;
        if (!busy && el("media-test").hidden) status("Could not start transcription: " + String(error));
        void runQueue();
    }
}
async function renderLibrary() {
    const render = ++libraryRender;
    try {
        const records = await listSyncRecords();
        if (render !== libraryRender) return;
        const currentUser = sharing.getUserId();
        const teams = currentUser === confirmedUser ? accessibleTeams : [];
        const allAnswers = projectLibrary(records, remoteAnswers, teams, currentUser);
        const filter = el<HTMLSelectElement>("person-filter"), selectedPerson = filter.value;
        const options = personOptions(allAnswers);
        filter.replaceChildren(...options.map(({value, label}) => new Option(label, value)));
        filter.value = options.some(option => option.value === selectedPerson) ? selectedPerson : ALL_PEOPLE;
        const groupBy = el<HTMLSelectElement>("group-by").value;
        const answers = filterLibrary(allAnswers, filter.value, groupBy === "question" ? "question" : "recent");
        selectedId = selectLibraryAnswer(answers, selectedId)?.id;
        el("library-count").textContent = `${answers.length} of ${allAnswers.length} recordings`;
        el("answers-nav").textContent = "Answers";
        const list = el("answer-list");
        list.replaceChildren();
        if (!answers.length) {
            const empty = document.createElement("li"); empty.className = "empty";
            empty.textContent = filter.value !== ALL_PEOPLE ? `No recordings for ${filter.selectedOptions[0].textContent}. ` : "No recordings yet. Record your first answer to review it here.";
            if (filter.value !== ALL_PEOPLE) { const reset = document.createElement("button"); reset.textContent = "Show all people"; reset.onclick = () => { filter.value = ALL_PEOPLE; void renderLibrary(); }; empty.append(reset); }
            list.append(empty);
            selectedId = undefined;
        }
        let previousGroup = "";
        for (const a of answers) {
            const groupId = groupBy === "question" ? a.questionId : "";
            const group = groupBy === "question" ? a.question : "";
            if (groupId && groupId !== previousGroup) {
                const heading = document.createElement("li");
                heading.className = "group-heading";
                heading.textContent = group;
                list.append(heading);
                previousGroup = groupId;
            }
            const li = document.createElement("li"), button = document.createElement("button");
            button.textContent = a.question;
            button.setAttribute("aria-current", String(a.id === selectedId));
            const meta = document.createElement("small");
            meta.textContent = `${personName(a)} · ${new Date(a.createdAt).toLocaleString()} · ${a.duration.toFixed(1)}s · ${a.status === "working" ? "Transcribing · " : a.status === "error" ? "Transcription failed · " : ""}${"syncState" in a && a.syncState === "error" ? "Upload failed — retry" : isLocal(a) ? (a.syncState === "synced" ? "Shared" : a.teamId ? "Upload pending" : "On this device") : "Shared"}`;
            button.append(meta);
            button.onclick = () => {
                selectedId = a.id;
                void renderLibrary();
            };
            li.append(button);
            list.append(li);
        }
        await renderDetail(answers.find(a => a.id === selectedId));
    }
    catch (error) {
        el("library-status").textContent = "Could not read browser storage: " + String(error);
    }
}
async function renderDetail(answer?: LibraryAnswer) {
    const existing = el("detail");
    if (answer && existing.dataset.answerId === answer.id) {
        const text = existing.querySelector<HTMLTextAreaElement>("textarea")!;
        if (!text.dataset.dirty)
            text.value = answer.transcript;
        existing.querySelector<HTMLElement>("[data-transcript-state]")!.textContent = answer.transcriptError ?? (answer.status === "working" ? "Transcribing on your device\u2026" : answer.status === "silent" ? EMPTY_TRANSCRIPT_MESSAGE : "");
        const retry = existing.querySelector<HTMLButtonElement>("[data-retry]")!;
        retry.dataset.retry = "true";
        retry.hidden = !isLocal(answer) || !mayEdit(answer);
        retry.disabled = answer.id === activeJob || jobs.includes(answer.id);
        return;
    }
    if (playbackURL)
        URL.revokeObjectURL(playbackURL);
    const detail = el("detail");
    detail.replaceChildren();
    detail.dataset.answerId = answer?.id ?? "";
    if (!answer)
        return;
    const heading = document.createElement("h2");
    heading.textContent = personName(answer) + " · " + answer.question;
    const video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.className = "player";
    video.setAttribute("aria-label", "Recorded answer");
    if (isLocal(answer)) {
        playbackURL = URL.createObjectURL(answer.video);
        video.src = playbackURL;
    } else {
        void sharing.downloadVideo(answer.objectPath!).then(blob => {
            if (selectedId !== answer.id || detail.dataset.answerId !== answer.id) return;
            if (playbackURL) URL.revokeObjectURL(playbackURL);
            playbackURL = URL.createObjectURL(blob); video.src = playbackURL;
        }).catch(error => { if (selectedId === answer.id) { detail.dataset.answerId = ""; el("library-status").textContent = "Could not load video. Refresh to retry. " + String(error); } });
    }
    const label = document.createElement("label");
    label.htmlFor = "transcript";
    label.textContent = mayEdit(answer) ? "Transcript (editable)" : "Transcript";
    const textarea = document.createElement("textarea");
    textarea.id = "transcript";
    textarea.value = answer.transcript;
    textarea.readOnly = !mayEdit(answer);
    let draftRevision = 0;
    textarea.oninput = () => {
        draftRevision++;
        textarea.dataset.dirty = "true";
    };
    textarea.placeholder = answer.status === "silent" ? EMPTY_TRANSCRIPT_MESSAGE : answer.status === "error" ? "Transcription failed. Retry below or type your answer." : "Transcription may take a moment on first use.";
    const state = document.createElement("p");
    state.dataset.transcriptState = "true";
    state.textContent = answer.transcriptError ?? (answer.status === "working" ? (progress || "Transcribing on your device\u2026") : answer.status === "pending" ? "Waiting for transcription\u2026" : answer.status === "silent" ? EMPTY_TRANSCRIPT_MESSAGE : "");
    const actions = document.createElement("div");
    actions.className = "actions";
    const button = (name: string, fn: () => void) => {
        const b = document.createElement("button");
        b.textContent = name;
        b.onclick = fn;
        actions.append(b);
        return b;
    };
    const saveButton = button("Save transcript", async () => {
        const savedText = textarea.value;
        const savedRevision = draftRevision;
        try {
            const exists = isLocal(answer) ? await updateAnswer(answer.id, current => {
                current.transcript = savedText;
                current.edited = true;
            }) : (await queueRemoteEdit(answer as sharing.RemoteAnswer, { transcript: savedText, edited: true }), true);
            void syncAndRefresh();
            if (exists && draftRevision === savedRevision && textarea.value === savedText)
                delete textarea.dataset.dirty;
            el("library-status").textContent = exists ? (textarea.dataset.dirty ? "Transcript saved. Newer changes are unsaved." : "Transcript saved.") : "This answer was deleted before the transcript could be saved.";
            await renderLibrary();
        }
        catch (error) {
            el("library-status").textContent = "Transcript could not be saved: " + String(error);
        }
    });
    saveButton.hidden = !mayEdit(answer);
    const retry = button("Retry transcription", () => {
        void (async () => {
            const current = await getAnswer(answer.id);
            if (!current)
                return;
            if ((textarea.dataset.dirty || current.edited) && !confirm("Replace your edited transcript with a new transcription?"))
                return;
            delete textarea.dataset.dirty;
            const exists = await updateAnswer(answer.id, record => {
                record.edited = false;
                record.status = "pending";
                record.transcriptError = undefined;
            });
            if (exists)
                enqueue(answer.id);
            await renderLibrary();
        })().catch(error => {
            el("library-status").textContent = String(error);
        });
    });
    retry.dataset.retry = "true";
    retry.hidden = !isLocal(answer) || !mayEdit(answer);
    retry.disabled = answer.id === activeJob || jobs.includes(answer.id);
    button("Download video", () => { void (async () => { const video = isLocal(answer) ? answer.video : await sharing.downloadVideo(answer.objectPath!); download({ ...answer, video } as Answer); })().catch(error => el("library-status").textContent = String(error)); });
    button("Download transcript", () => {
        const url = URL.createObjectURL(new Blob([answer.question + "\n\n" + textarea.value], { type: "text/plain" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = "transcript-" + answer.id + ".txt";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const deleteButton = button("Delete answer", () => {
        if (confirm("Delete this answer and its transcript?"))
            void (async () => {
                if (isLocal(answer)) await markDeleted(answer.id);
                else await queueRemoteDelete(answer as sharing.RemoteAnswer);
                if (activeJob === answer.id) { worker?.terminate(); worker = undefined; activeJob = undefined; clearTimeout(jobTimer); }
                const queued = jobs.indexOf(answer.id); if (queued >= 0) jobs.splice(queued, 1);
                remoteAnswers = remoteAnswers.filter(a => a.id !== answer.id);
                await renderLibrary(); void syncAndRefresh(); void runQueue();
            })().catch(error => el("library-status").textContent = String(error));
    });
    deleteButton.hidden = !mayEdit(answer);
    detail.append(heading, video, label, textarea, state, actions);
}
window.addEventListener("beforeunload", event => {
    if (busy || unsaved) {
        event.preventDefault();
        event.returnValue = "";
    }
});
window.addEventListener("keydown", event => {
    const target = event.target as HTMLElement;
    if (target.closest("button,textarea,input,select,video,a") || event.repeat || busy || el("practice").hidden)
        return;
    if (event.code === "ArrowRight") {
        el("next").click();
        event.preventDefault();
    }
});
question();
timingSummary();
controls();
status("Choose a person, then start practice. Recording begins automatically after preparation.");
void listAnswers().then(answers => {
    el("answers-nav").textContent = "Answers";
    for (const answer of answers)
        if (answer.status === "pending" || answer.status === "working")
            enqueue(answer.id);
}).catch(error => status("Browser storage is unavailable. Recordings can still be downloaded: " + String(error)));

function savePreference() {
    try {
        if (team) localStorage.setItem("vcrecord-team", JSON.stringify({ id: team.id }));
        else localStorage.removeItem("vcrecord-team");
        if (invitation?.invite) localStorage.setItem("vcrecord-invitation", JSON.stringify(invitation));
    } catch {}
}
function teamControls() {
    const connected = !!team && confirmedUser === sharing.getUserId() && accessibleTeams.includes(team.id);
    el("copy-invite").hidden = !connected || !invitation?.invite || !accessibleTeams.includes(invitation.id);
    el("refresh-team").hidden = false;
    el<HTMLButtonElement>("refresh-team").disabled = connecting;
    el("share-saved").hidden = !connected;
    el("library-context").textContent = connected ? "Shared cofounder answers and recordings on this device." : "Recordings on this device. Open your private team invite to connect a new browser.";
    void listAnswers().then(answers => {
        const count = answers.filter(a => !a.teamId).length;
        el("share-saved").textContent = `Share saved answers (${count} local)`;
        el<HTMLButtonElement>("share-saved").disabled = !count || connecting;
    }).catch(() => {});
}
async function refreshRemote(): Promise<boolean> {
    const user = sharing.getUserId(), teams = [...accessibleTeams], generation = connectionGeneration;
    if (!user || user !== confirmedUser || !teams.length) return false;
    const refresh = ++remoteRefresh;
    // Two requests at a time; successful teams refresh even when another team is unavailable.
    const results: PromiseSettledResult<sharing.RemoteAnswer[]>[] = [];
    for (let i = 0; i < teams.length; i += 2) results.push(...await Promise.allSettled(teams.slice(i, i + 2).map(id => sharing.fetchAnswers(id))));
    if (refresh !== remoteRefresh || generation !== connectionGeneration || sharing.getUserId() !== user) return false;
    const failed: string[] = [];
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled") remoteAnswers = [...remoteAnswers.filter(a => a.teamId !== teams[i]), ...result.value];
        else failed.push(teams[i]);
    }
    if (failed.length) el("team-status").textContent = `Could not refresh ${failed.length} of ${teams.length} teams. Showing saved results and local recordings. Refresh / retry sync.`;
    return !failed.length;
}
async function refreshLibraryConnection() {
    const generation = connectionGeneration, user = sharing.getUserId();
    const pendingRefresh = refreshRemote(), refresh = remoteRefresh;
    const refreshed = await pendingRefresh;
    const failures = (await listSyncRecords()).filter(a => a.syncState === "error" && a.ownerId === sharing.getUserId()).length;
    if (refresh !== remoteRefresh || generation !== connectionGeneration || sharing.getUserId() !== user) return false;
    if (failures) el("team-status").textContent = `${failures} uploads or changes failed. Recordings remain on this device. Refresh / retry sync.`;
    else if (refreshed && team && confirmedUser === user && accessibleTeams.includes(team.id)) {
        // The current refresh owns completion, including navigation that supersedes initialization.
        el("team-status").textContent = "Shared cofounder library connected.";
    }
    if (!el("library").hidden) await renderLibrary();
    return refreshed && !failures;
}
async function syncAndRefresh() {
    await drainSync(() => { if (!el("library").hidden) return renderLibrary(); });
    return refreshLibraryConnection();
}
async function initializeTeam() {
    const generation = ++connectionGeneration;
    ++remoteRefresh; connecting = true; teamControls();
    el("team-status").textContent = "Connecting to your cofounder library…";
    try {
        const user = await sharing.ensureSession();
        if (generation !== connectionGeneration) return;
        if (confirmedUser !== user) { remoteAnswers = []; accessibleTeams = []; team = undefined; confirmedUser = null; }
        const rawPending = stored("vcrecord-pending-invite");
        const pending = readTeam(rawPending);
        if (rawPending && !pending?.invite) { try { localStorage.removeItem("vcrecord-pending-invite"); } catch {} throw new Error("Invalid invitation. Open the original private invite again."); }
        if (pending?.invite) {
            await sharing.joinTeam(pending.id, pending.invite);
            if (generation !== connectionGeneration || sharing.getUserId() !== user) return;
            invitation = { id: pending.id, invite: pending.invite };
            try { localStorage.setItem("vcrecord-invitation", JSON.stringify(invitation)); localStorage.removeItem("vcrecord-pending-invite"); } catch {}
        }
        const memberships = await sharing.fetchAccessibleTeams();
        if (generation !== connectionGeneration || sharing.getUserId() !== user) return;
        const preference = team?.id ?? readTeam(stored("vcrecord-team"))?.id;
        accessibleTeams = memberships.map(m => m.id); confirmedUser = user;
        remoteAnswers = remoteAnswers.filter(a => accessibleTeams.includes(a.teamId));
        const preferredMembership = memberships.find(m => m.id === preference);
        const destination = preferredMembership?.canonicalTeamId ?? [...memberships].sort((a,b) => a.canonicalTeamId.localeCompare(b.canonicalTeamId))[0]?.canonicalTeamId;
        const fallback = accessibleTeams.includes(preference ?? "") ? preference : [...accessibleTeams].sort()[0];
        team = destination && accessibleTeams.includes(destination) ? { id: destination } : fallback ? { id: fallback } : undefined;
        savePreference(); teamControls();
        if (!el("library").hidden) await renderLibrary();
        if (!team) { el("team-status").textContent = "Local practice ready. Open the private cofounder invite to connect this browser."; return; }
        await syncAndRefresh();
    } catch (error) {
        if (generation !== connectionGeneration) return;
        // Never use an unverified preference for new recording assignment.
        team = undefined;
        if (confirmedUser !== sharing.getUserId()) { remoteAnswers = []; accessibleTeams = []; confirmedUser = null; }
        el("team-status").textContent = "Could not connect. Local recordings remain available. Refresh / retry sync. " + String(error);
    } finally {
        if (generation === connectionGeneration) { connecting = false; teamControls(); if (!el("library").hidden) void renderLibrary(); }
    }
}
el("copy-invite").onclick = async () => {
    if (!invitation?.invite) return;
    try { await navigator.clipboard.writeText(location.origin + location.pathname + "#team=" + invitation.id + "&invite=" + invitation.invite); el("team-status").textContent = "Invite copied."; }
    catch { el("team-status").textContent = "Clipboard unavailable. Allow clipboard access and retry."; }
};
el("refresh-team").onclick = () => void initializeTeam();
el("share-saved").onclick = async () => {
    if (!team || confirmedUser !== sharing.getUserId() || !accessibleTeams.includes(team.id)) return;
    const destination = team.id, userId = confirmedUser;
    try { for (const answer of await listAnswers()) if (!answer.teamId) await assignTeam(answer.id, destination, userId!); await syncAndRefresh(); teamControls(); }
    catch (error) { el("team-status").textContent = String(error); }
};
window.addEventListener("online", () => void initializeTeam());
window.addEventListener("focus", () => { if (!el("library").hidden) void initializeTeam(); });
sharing.onSessionChange(user => {
    if (confirmedUser && confirmedUser !== user) {
        ++connectionGeneration; ++remoteRefresh;
        remoteAnswers = []; accessibleTeams = []; confirmedUser = null; team = undefined; connecting = false;
        el("team-status").textContent = "Browser identity changed. Refresh to reconnect; local recordings remain available.";
        teamControls();
        el("detail").dataset.answerId = "";
        if (!el("library").hidden) void renderLibrary();
    }
});
teamControls(); void initializeTeam();
window.addEventListener("hashchange", () => { if (captureInvitation()) void initializeTeam(); });
