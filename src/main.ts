import "@fontsource/lato/latin-400.css";
import "@fontsource/lato/latin-700.css";
import "./style.css";
import { questions, tips } from "./questions";
import { startCapture } from "./capture";
import { readTiming, validTiming } from "./timing";
import { listAnswers, listSyncRecords, getAnswer, saveAnswer, updateAnswer, type Answer, type RemotePendingAnswer } from "./storage";
import * as sharing from "./sharing";
import { drainSync, assignTeam, markDeleted, queueRemoteEdit, queueRemoteDelete } from "./sync";
type LibraryAnswer = Answer | sharing.RemoteAnswer | RemotePendingAnswer;
function captureInvitation() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    if (!fragment.has("team") || !fragment.has("invite")) return false;
    try { localStorage.setItem("vcrecord-pending-invite", JSON.stringify({ id: fragment.get("team"), invite: fragment.get("invite") })); } catch {}
    history.replaceState(null, "", location.pathname + location.search);
    return true;
}
captureInvitation();
const stored = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
let team: { id: string; invite?: string } | undefined;
try { team = JSON.parse(localStorage.getItem("vcrecord-team") ?? "null") ?? undefined; } catch {}
let remoteAnswers: sharing.RemoteAnswer[] = [];
let remoteRefresh = 0, libraryRender = 0;
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<header><strong>VC Record</strong><nav aria-label="Main"><button id="practice-nav">Practice</button><button id="answers-nav">Answers</button></nav></header><main><div class="team-controls"><button id="create-team">Create shared team</button><button id="copy-invite" hidden>Copy invite</button><button id="refresh-team" hidden>Refresh / retry sync</button><button id="share-saved" hidden>Share saved answers</button><span id="team-status" role="status"></span></div><section id="practice"><h1 id="question" hidden></h1><p id="phase" class="position">Ready to practice</p><div class="timer" id="timer" aria-label="Seconds remaining" hidden>15</div><video id="preview" autoplay muted playsinline hidden aria-label="Camera preview"></video><p class="person-field"><label for="person">Answering as </label><input id="person" maxlength="80" autocomplete="name" placeholder="Your name"></p><div class="actions"><button id="record" class="primary">Start practice</button><button id="cancel" hidden>Cancel</button><button id="stop" hidden>Stop &amp; save</button><button id="next">Next question</button></div><p id="status" class="status" role="status" aria-live="polite"></p><div class="actions" id="rescue" hidden><button id="rescue-download">Download unsaved recording</button><button id="rescue-retry">Retry saving</button></div><details id="timing-settings"><summary>Timing settings</summary><form id="timing-form" novalidate><label for="prep-seconds">Preparation seconds</label><input id="prep-seconds" type="number" min="1" max="120" step="1" required><label for="answer-seconds">Answer seconds</label><input id="answer-seconds" type="number" min="5" max="30" step="1" required><button>Save timing</button><p id="timing-error" role="status"></p></form></details><p id="timing-summary" class="position"></p><p id="tip" class="tip" hidden></p></section><section class="library" id="library" hidden><h1>Answers</h1><p><span id="library-context">Answers saved in this browser.</span></p><p><label for="group-by">Group answers by </label><select id="group-by"><option value="question">Question</option><option value="person">Person</option><option value="recent">Most recent</option></select></p><p id="library-status" role="status"></p><div class="library-layout"><ul class="answer-list" id="answer-list"></ul><div class="detail" id="detail"></div></div></section></main>`;
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
el<HTMLInputElement>("person").value = owner.name;
function saveOwner() {
    owner.name = el<HTMLInputElement>("person").value.trim();
    try {
        localStorage.setItem("vcrecord-owner", JSON.stringify(owner));
    }
    catch {
    }
}
el("person").onchange = saveOwner;
const personName = (answer: LibraryAnswer): string => answer.person ?? "Unassigned";
const personGroup = (answer: LibraryAnswer) => personName(answer).trim().toLocaleLowerCase();
const isLocal = (answer: LibraryAnswer): answer is Answer => "video" in answer;
const mayEdit = (answer: LibraryAnswer) => !answer.ownerId || answer.ownerId === sharing.getUserId();
el("group-by").onchange = () => void renderLibrary();
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
    saveOwner();
    if (!owner.name) { status("Enter your name, then start practice."); el("person").focus(); return; }
    el<HTMLDetailsElement>("timing-settings").open = false;
    const token = ++generation;
    const abort = new AbortController(); attemptAbort = abort;
    const current = () => token === generation;
    const frozen = { ...currentQuestion }, selectedTiming = { ...timing };
    const person = owner.name, personId = owner.id;
    const assignedTeam = team?.id, assignedOwner = sharing.getUserId();
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
    cancelAttempt();
    const choices = questions.filter(q => q.id !== currentQuestion.id);
    currentQuestion = choices[Math.floor(Math.random() * choices.length)];
    question(); void beginAttempt();
};
function practice() {
    if (phase === "recording" || phase === "saving") return;
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
    cancelAttempt();
    el("practice").hidden = true;
    el("library").hidden = false;
    void refreshRemote().then(() => renderLibrary());
};
function queueWorker() {
    if (worker)
        return worker;
    worker = new Worker(new URL("./transcribe.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = async (event) => {
        const msg = event.data;
        if (msg.status === "progress") {
            progress = msg.message;
            if (!busy)
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
            if (!busy)
                status(msg.status === "done" ? "Transcript ready in Answers." : msg.status === "silent" ? "Answer saved. No speech detected." : "Answer saved. Transcription failed; retry in Answers.");
            if (!el("library").hidden)
                await renderLibrary();
        }
        catch (error) {
            if (!busy) status("Recording remains saved, but transcript could not be saved: " + String(error));
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
        if (!busy) status("Recording saved. Speech worker could not start; retry in Answers.");
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
            if (!busy)
                status("Recording saved. Transcription timed out; retry in Answers.");
            if (!el("library").hidden)
                await renderLibrary();
            void runQueue();
        }, 180000);
    }
    catch (error) {
        activeJob = undefined;
        if (!busy) status("Could not start transcription: " + String(error));
        void runQueue();
    }
}
async function renderLibrary() {
    const render = ++libraryRender;
    try {
        const records = await listSyncRecords();
        if (render !== libraryRender) return;
        const answers: LibraryAnswer[] = [...records.filter(a => !a.deletedAt && (!a.teamId || a.teamId === team?.id)), ...remoteAnswers.filter(a => a.teamId === team?.id && !records.some(l => l.id === a.id))];
        answers.sort((a,b) => b.createdAt - a.createdAt);
        const groupBy = el<HTMLSelectElement>("group-by").value;
        if (groupBy !== "recent")
            answers.sort((a, b) => (groupBy === "person" ? personGroup(a).localeCompare(personGroup(b)) : questions.findIndex(q => q.id === a.questionId) - questions.findIndex(q => q.id === b.questionId)) || b.createdAt - a.createdAt);
        el("answers-nav").textContent = "Answers";
        const list = el("answer-list");
        list.replaceChildren();
        if (!answers.length) {
            list.innerHTML = "<li class=\"empty\">Record your first answer to review it here.</li>";
            selectedId = undefined;
        }
        else if (!answers.some(a => a.id === selectedId))
            selectedId = answers[0].id;
        let previousGroup = "";
        for (const a of answers) {
            const groupId = groupBy === "question" ? a.questionId : groupBy === "person" ? personGroup(a) : "";
            const group = groupBy === "question" ? a.question : groupBy === "person" ? personName(a) : "";
            if (groupId && groupId !== previousGroup) {
                const heading = document.createElement("li");
                heading.className = "group-heading";
                heading.textContent = group;
                list.append(heading);
                previousGroup = groupId;
            }
            const li = document.createElement("li"), button = document.createElement("button");
            button.textContent = groupBy === "question" ? personName(a) : a.question;
            button.setAttribute("aria-current", String(a.id === selectedId));
            const meta = document.createElement("small");
            meta.textContent = `${personName(a)} · ${new Date(a.createdAt).toLocaleString()} · ${a.duration.toFixed(1)}s · ${a.edited ? "Edited transcript" : a.status} · ${isLocal(a) ? (a.syncState === "synced" ? "Shared" : a.syncState === "error" ? "Sync failed — retry" : a.teamId ? "Sync pending" : "Local") : "Shared"}`;
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
        existing.querySelector<HTMLElement>("[data-transcript-state]")!.textContent = answer.transcriptError ?? (answer.status === "working" ? "Transcribing on your device\u2026" : answer.status === "silent" ? "No speech detected." : "");
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
    textarea.placeholder = answer.status === "silent" ? "No speech detected. Add your own transcript." : answer.status === "error" ? "Transcription failed. Retry below or type your answer." : "Transcription may take a moment on first use.";
    const state = document.createElement("p");
    state.dataset.transcriptState = "true";
    state.textContent = answer.transcriptError ?? (answer.status === "working" ? (progress || "Transcribing on your device\u2026") : answer.status === "pending" ? "Waiting for transcription\u2026" : answer.status === "silent" ? "No speech detected." : "");
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
    if (target.closest("button,textarea,input,video,a") || event.repeat || busy || el("practice").hidden)
        return;
    if (event.code === "ArrowRight") {
        el("next").click();
        event.preventDefault();
    }
});
question();
timingSummary();
controls();
status("Enter your name, then start practice. Recording begins automatically after preparation.");
void listAnswers().then(answers => {
    el("answers-nav").textContent = "Answers";
    for (const answer of answers)
        if (answer.status === "pending" || answer.status === "working")
            enqueue(answer.id);
}).catch(error => status("Browser storage is unavailable. Recordings can still be downloaded: " + String(error)));

function teamControls() {
    el("create-team").hidden = !!team;
    el("copy-invite").hidden = !team?.invite;
    el("refresh-team").hidden = !team && !stored("vcrecord-pending-invite");
    el("share-saved").hidden = !team;
    el("library-context").textContent = team ? "Team answers and your saved local answers." : "Answers saved in this browser.";
}
async function refreshRemote() {
    if (!team) return;
    const refresh = ++remoteRefresh;
    const teamId = team.id;
    try { const answers = await sharing.fetchAnswers(teamId); if (refresh === remoteRefresh && team?.id === teamId) remoteAnswers = answers; }
    catch (error) { el("team-status").textContent = "Team unavailable. Your local recordings are safe. Retry sync. " + String(error); }
}
async function syncAndRefresh() {
    await drainSync(() => { if (!el("library").hidden) return renderLibrary(); }); await refreshRemote();
    if (!el("library").hidden) await renderLibrary();
}
async function initializeTeam() {
    try {
        if (team || stored("vcrecord-pending-invite")) await sharing.ensureSession();
        const pending = JSON.parse(stored("vcrecord-pending-invite") ?? "null");
        if (pending) {
            await sharing.joinTeam(pending.id, pending.invite);
            team = pending; localStorage.setItem("vcrecord-team", JSON.stringify(team));
            localStorage.removeItem("vcrecord-pending-invite");
        }
        teamControls(); await syncAndRefresh();
        if (team) el("team-status").textContent = "Shared team connected.";
    } catch (error) { el("team-status").textContent = "Could not connect to team. Refresh / retry sync. " + String(error); teamControls(); }
}
el("create-team").onclick = async () => {
    const button = el<HTMLButtonElement>("create-team"); button.disabled = true;
    try { await sharing.ensureSession(); team = await sharing.createTeam("Cofounders"); localStorage.setItem("vcrecord-team", JSON.stringify(team)); teamControls(); el("team-status").textContent = "Team ready. Copy the invite for your cofounders."; }
    catch (error) { el("team-status").textContent = "Could not create team. Try again. " + String(error); }
    finally { button.disabled = false; }
};
el("copy-invite").onclick = async () => {
    try { await navigator.clipboard.writeText(location.origin + location.pathname + "#team=" + team!.id + "&invite=" + team!.invite); el("team-status").textContent = "Invite copied."; }
    catch { el("team-status").textContent = "Clipboard unavailable. Allow clipboard access and retry."; }
};
el("refresh-team").onclick = () => void initializeTeam();
el("share-saved").onclick = async () => {
    try { const userId = await sharing.ensureSession(); for (const answer of await listAnswers()) if (!answer.teamId) await assignTeam(answer.id, team!.id, userId); await syncAndRefresh(); el("team-status").textContent = "Saved answers assigned to this team. Failed uploads can be retried."; }
    catch (error) { el("team-status").textContent = String(error); }
};
window.addEventListener("online", () => void initializeTeam());
window.addEventListener("focus", () => { if (!el("library").hidden) void syncAndRefresh(); });
teamControls(); void initializeTeam();

window.addEventListener("hashchange", () => { if (captureInvitation()) void initializeTeam(); });
