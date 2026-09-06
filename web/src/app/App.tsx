import { useEffect, useRef, useState, type FormEvent } from "react";
import { GATEWAY_VERSION, type ModelsDTO, type SendPromptInput } from "@dsh-mobile/protocol";
import { useStore, projectConversation, store } from "../state/store";
import { projectInbox } from "../projections/inbox";
import { api, loadHistory } from "../api/gateway-client";
import { connection } from "../sync/connection";
import qrcode from "../pairing/qrcode.js";
import { ApprovalCard, QuestionCard } from "../components/Interactions";
import { Markdown } from "../components/Markdown";
import "./styles.css";

const labels: Record<string, string> = { approval: "Approval required", question: "An answer is needed", completed: "Completed", pending: "Not started", failed: "Failed", waiting: "Waiting for input", running: "Running", idle: "Ready", unknown: "Status unavailable" };
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = { inbox: "M4 4h16v16H4z M4 13h5l2 3h2l2-3h5", tasks: "m4 6 2 2 4-4 M13 6h7 M4 14l2 2 4-4 M13 14h7 M13 20h7", sessions: "M4 4h16v13H9l-5 4z M8 8h8 M8 12h5", settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6", arrow: "m9 5 7 7-7 7", back: "m15 5-7 7 7 7", plus: "M12 5v14 M5 12h14", send: "m5 12 7-7 7 7 M12 5v15", image: "M4 4h16v16H4z m0 12 5-5 4 4 3-3 4 4 M15 8h.01", check: "m5 12 4 4L19 6" };
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] ?? paths.sessions}/></svg>;
}
function initialSession() { const match = location.pathname.match(/^\/session\/([^/]+)$/); try { return match ? decodeURIComponent(match[1]) : undefined; } catch { return undefined; } }
const pairingToken = new URLSearchParams(location.search).get("t") ?? "";
if (location.pathname === "/pair") history.replaceState(null, "", "/pair");

export function App() {
  const state = useStore();
  const [tab, setTab] = useState("inbox"), [selected, setSelected] = useState<string | undefined>(initialSession), [sessionTab, setSessionTab] = useState("conversation");
  const [workspace, setWorkspace] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [update, setUpdate] = useState(false);
  const online = state.connection === "online";
  const supported = (cap: string) => state.hello?.capabilities.includes(cap) ?? false;
  const inbox = projectInbox(state);
  useEffect(() => { connection.start(); return () => connection.stop(); }, []);
  useEffect(() => { if (selected) void connection.select(selected).catch(e => setError(e.message)); }, [selected]);
  useEffect(() => {
    const pop = () => setSelected(initialSession()); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (state.hello && state.hello.gatewayVersion !== GATEWAY_VERSION) setUpdate(true);
    const changed = () => setUpdate(true); window.addEventListener("app-update", changed); return () => window.removeEventListener("app-update", changed);
  }, [state.hello]);
  function open(id: string) { setSelected(id); setSessionTab("conversation"); setError(""); history.pushState(null, "", "/session/" + encodeURIComponent(id)); }
  function back() { setSelected(undefined); history.pushState(null, "", "/"); }
  async function create() {
    setBusy(true); setError("");
    try { const result = await api("/api/sessions", workspace ? { workspaceId: workspace } : {}); open(result.sessionId); await connection.connect(); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (state.connection === "pairing" || (pairingToken && location.pathname === "/pair")) return <Pairing onPaired={() => { history.replaceState(null, "", "/"); connection.start(); }} />;
  const session = selected ? state.sessions[selected] : undefined;
  const sessions = Object.values(state.sessions).filter(s => !workspace || s.workspaceId === workspace).sort((a, b) => b.updatedAt - a.updatedAt);
  const needs = inbox.filter(i => ["approval", "question", "waiting"].includes(i.kind));
  return <div className="app-shell">
    <aside className="desktop-rail"><div className="product-name">DSH Mobile</div><p className="rail-label">WORKSPACE</p>{["inbox", "tasks", "sessions"].map(name => <button key={name} className={tab === name && !selected ? "selected" : ""} onClick={() => { back(); setTab(name); }}><Icon name={name}/>{name[0].toUpperCase() + name.slice(1)}{name === "inbox" && needs.length > 0 && <span className="count">{needs.length}</span>}</button>)}<div className="rail-bottom"><span className={"dot " + (online ? "live" : "")}/>{state.host?.name ?? "Connecting to host"}</div></aside>
    <div className="main-column">
      <header className="topbar"><div className="view-identity"><span className={"dot " + (online ? "live" : "")} aria-hidden="true"/><small>{state.host?.name ?? "Connecting"}</small></div><button className="icon-button" aria-label="Settings" onClick={() => { back(); setTab("settings"); }}><Icon name="settings"/></button></header>
      {!online && <div className="connection-banner" role="status"><span className="dot"/>{state.connection === "connecting" ? "Connecting and syncing…" : "Offline · showing last known state"}<button onClick={() => void connection.connect()}>Retry</button></div>}
      {state.host?.id === "demo" && <div className="demo-banner">LOCAL PREVIEW <span>No AI model is connected</span></div>}
      {update && <div className="connection-banner">An update is available.<button disabled={busy} onClick={() => { if (!busy) { void navigator.serviceWorker?.getRegistration().then(r => r?.waiting?.postMessage("ACTIVATE")); location.reload(); } }}>Reload when ready</button></div>}
      {(error || state.error) && <div className="error-banner" role="alert">{error || state.error}<button onClick={() => setError("")}>Dismiss</button></div>}
      {selected ? <><div className="session-heading"><button className="icon-button" aria-label="Back" onClick={back}><Icon name="back"/></button><div><h1>{session?.title ?? "Loading session…"}</h1><span className="muted">{labels[session?.status ?? "unknown"] ?? session?.status}</span></div></div><div className="subnav">{["conversation", "activity", ...(supported("images") ? ["files"] : [])].map(name => <button key={name} className={sessionTab === name ? "active" : ""} onClick={() => setSessionTab(name)}>{name[0].toUpperCase() + name.slice(1)}</button>)}</div><Conversation key={selected} sessionId={selected} view={sessionTab} online={online} onBusy={setBusy}/></> :
      <main className="dashboard">
        {tab === "inbox" && <><div className="section-heading"><h2>Needs your attention</h2><span className="count">{needs.length}</span></div>{needs.length === 0 ? <Empty title="You're all caught up" detail="Approvals and questions will appear here."/> : <div className="attention-list">{needs.map(item => <button className="attention-card" key={item.id} onClick={() => open(item.sessionId)}><span className={"item-symbol " + item.kind}>{item.kind === "approval" ? "!" : "?"}</span><span className="card-copy"><small>{labels[item.kind]}</small><strong>{item.title}</strong><span>{state.workspaces[state.sessions[item.sessionId]?.workspaceId ?? ""]?.title ?? "Workspace"}</span></span><Icon name="arrow"/></button>)}</div>}<div className="section-heading recent-heading"><h2>Recent progress</h2><span className="muted">FROM YOUR WORKSPACE</span></div>{inbox.filter(i => ["completed", "failed"].includes(i.kind)).map(item => <button className="progress-row" key={item.id} onClick={() => open(item.sessionId)}><span className="completed-icon"><Icon name="check"/></span><span className="card-copy"><strong>{item.title}</strong><small>{labels[item.kind]}</small></span><Icon name="arrow"/></button>)}<div className="quiet-note"><span className="dot live"/>Your agent keeps working when you step away.</div></>}
        {tab === "tasks" && <><div className="page-intro"><div className="eyebrow">THE BIG PICTURE</div><h1>Your tasks.</h1><p>Follow the work, from start to finish.</p></div>{!supported("tasks") ? <Empty title="Tasks aren't available" detail="This host does not currently provide task status."/> : Object.values(state.tasks).length ? Object.values(state.tasks).map(task => <button className="task-card" key={task.id} onClick={() => open(task.sessionId)}><span className={"badge " + task.status}>{labels[task.status] ?? task.status}</span><h3>{task.title}</h3><p>{task.detail ?? state.sessions[task.sessionId]?.title}</p><span className="task-footer">Open session <Icon name="arrow"/></span></button>) : <Empty title="No tasks yet" detail="Start a session to get things moving."/>}</>}
        {tab === "sessions" && <><div className="page-intro"><div className="eyebrow">PICK UP WHERE YOU LEFT OFF</div><h1>Conversations.</h1><p>A direct line to your workspace.</p></div><div className="session-controls">{supported("workspaces") && <select aria-label="Workspace" value={workspace} onChange={e => setWorkspace(e.target.value)}><option value="">All workspaces</option>{Object.values(state.workspaces).map(w => <option key={w.id} value={w.id}>{w.title}</option>)}</select>}<button className="primary" disabled={!online || busy || !supported("sessions")} onClick={() => void create()}><Icon name="plus"/>New session</button></div>{sessions.map(s => <button className="session-card" key={s.id} onClick={() => open(s.id)}><span className="session-icon"><Icon name="sessions"/></span><span className="card-copy"><strong>{s.title}</strong><small>{state.workspaces[s.workspaceId ?? ""]?.title ?? "Workspace"} · {labels[s.status] ?? s.status}</small></span><Icon name="arrow"/></button>)}{!sessions.length && <Empty title="Room for something new" detail="Create your first session above."/>}</>}
        {tab === "settings" && <Settings online={online}/>}
      </main>}
      {!selected && <nav className="bottom-nav" aria-label="Main navigation">{["inbox", "tasks", "sessions"].map(name => <button key={name} className={tab === name ? "active" : ""} onClick={() => setTab(name)}><span className="nav-icon"><Icon name={name}/>{name === "inbox" && needs.length > 0 && <i>{needs.length}</i>}</span><span>{name[0].toUpperCase() + name.slice(1)}</span></button>)}</nav>}
    </div>
  </div>;
}
function Empty({ title, detail }: { title: string; detail: string }) { return <div className="empty"><Icon name="check"/><h3>{title}</h3><p>{detail}</p></div>; }
function Pairing({ onPaired }: { onPaired: () => void }) {
  const [token, setToken] = useState(pairingToken), [name, setName] = useState("My phone"), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  return <main className="pairing-page"><div className="brand"><span className="brand-mark">d</span>DSH Mobile</div><div className="pairing-illustration"><Icon name="sessions"/><span className="pairing-line"/><span className="brand-mark">d</span></div><div className="eyebrow">A DIRECT LINE TO YOUR AGENT</div><h1>Your workspace.<br/>In your pocket.</h1><p>Open a pairing link from your Harness host, or paste its one-time code below.</p><form onSubmit={e => { e.preventDefault(); setBusy(true); setError(""); void api("/api/pair", { token, name }).then(() => { setToken(""); onPaired(); }).catch(e => setError(e.message)).finally(() => setBusy(false)); }}><label>Device name<input value={name} maxLength={80} required onChange={e => setName(e.target.value)}/></label><label>One-time pairing code<input value={token} autoComplete="off" spellCheck={false} required onChange={e => setToken(e.target.value.trim())}/></label><button className="primary" disabled={busy || !token || !name.trim()}>{busy ? "Connecting…" : "Connect to workspace"}<Icon name="arrow"/></button>{error && <p role="alert" className="error-text">{error}</p>}</form><small className="muted">Pairing links expire after 5 minutes.<br/>Once connected, add this app to your Home Screen.</small></main>;
}
function Conversation({ sessionId, view, online, onBusy }: { sessionId: string; view: string; online: boolean; onBusy: (busy: boolean) => void }) {
  const state = useStore(); const { messages, tools } = projectConversation(state.events[sessionId] ?? []);
  const [text, setText] = useState(""), [mode, setMode] = useState<"queue" | "steer">("queue"), [images, setImages] = useState<SendPromptInput["images"]>([]);
  const [sending, setSending] = useState(false), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const [models, setModels] = useState<ModelsDTO>(), [model, setModel] = useState<{ provider: string; model: string } | undefined>(undefined), [selecting, setSelecting] = useState(false);
  const tail = useRef<HTMLDivElement>(null), nearBottom = useRef(true), request = useRef<{ id: string; digest: string } | undefined>(undefined);
  const supported = (cap: string) => state.hello?.capabilities.includes(cap) ?? false;
  const modelsUrl = "/api/sessions/" + encodeURIComponent(sessionId) + "/models";
  useEffect(() => {
    if (!online || !supported("models")) return;
    let live = true;
    void api<ModelsDTO>(modelsUrl).then(m => { if (live) { setModels(m); setModel(m.current ? { provider: m.current.provider, model: m.current.model } : undefined); } }).catch(() => {});
    return () => { live = false; };
  }, [sessionId, online, state.hello]);
  async function pickModel(value: string) {
    if (!models) return;
    const cut = value.indexOf("/"); if (cut < 0) return;
    const previous = model, selection = { provider: value.slice(0, cut), model: value.slice(cut + 1) };
    setSelecting(true); setError("");
    try {
      await api("/api/model", { sessionId, ...selection });
      setModel(selection); setModels({ ...models, current: selection });
      const refreshed = await api<ModelsDTO>(modelsUrl);
      setModels(refreshed); setModel(refreshed.current ? { provider: refreshed.current.provider, model: refreshed.current.model } : undefined);
    } catch (e) { setError((e as Error).message); setModel(previous); }
    finally { setSelecting(false); }
  }
  useEffect(() => { if (nearBottom.current) tail.current?.scrollIntoView({ block: "end" }); }, [messages.at(-1)?.text, view]);
  useEffect(() => { const listener = () => { nearBottom.current = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 220; }; window.addEventListener("scroll", listener, { passive: true }); return () => window.removeEventListener("scroll", listener); }, []);
  async function send(e: FormEvent) {
    e.preventDefault(); if (!online || sending) return;
    setSending(true); onBusy(true); setError("");
    const digest = JSON.stringify({ text, images, mode });
    if (request.current?.digest !== digest) request.current = { digest, id: crypto.randomUUID() };
    try { await api("/api/prompt", { sessionId, text, mode, images, requestId: request.current.id }); setText(""); setImages([]); request.current = undefined; nearBottom.current = true; }
    catch (e) { setError((e as Error).message); }
    finally { setSending(false); onBusy(false); }
  }
  async function upload(files: FileList | null) {
    if (!files) return;
    try {
      if (files.length + images.length > 4) throw new Error("Choose up to 4 images.");
      const loaded = await Promise.all([...files].map(file => new Promise<SendPromptInput["images"][number]>((resolve, reject) => {
        if (file.size > 3_500_000 || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) return reject(new Error("Use PNG, JPEG, WebP or GIF, up to 3.5 MB each."));
        const reader = new FileReader(); reader.onload = () => resolve({ name: file.name, mediaType: file.type as any, data: String(reader.result).split(",")[1] }); reader.onerror = () => reject(new Error("Couldn't read this image")); reader.readAsDataURL(file);
      })));
      setImages(prev => [...prev, ...loaded]); setError("");
    } catch (e) { setError((e as Error).message); }
  }
  const imageUrl = (id: string) => "/api/sessions/" + encodeURIComponent(sessionId) + "/images/" + encodeURIComponent(id);
  const modelValue = model && models?.groups.some(g => g.id === model.provider && g.models.some(m => m.id === model.model)) ? model.provider + "/" + model.model : "";
  return <div className="conversation-layout">
    <div className="conversation-body">
      {view === "conversation" && <>{state.cursors[sessionId] && <button className="load-earlier" disabled={!online || loading} onClick={() => { setLoading(true); void loadHistory(sessionId, state.cursors[sessionId]).catch(e => setError(e.message)).finally(() => setLoading(false)); }}>{loading ? "Loading…" : "Load earlier messages"}</button>}{messages.map(m => <article className={"message " + m.role} key={m.id}><div className="message-author">{m.role === "assistant" ? <><span className="agent-mark">d</span>Agent</> : "You"}{!m.complete && <span className="streaming-dot"/>}</div><Markdown text={m.text}/>{m.images.map(i => <a href={imageUrl(i.id)} target="_blank" rel="noreferrer" key={i.id}><img className="message-image" src={imageUrl(i.id)} alt={i.name} loading="lazy"/></a>)}</article>)}{tools.length > 0 && <details className="tool-summary"><summary>{tools.length} tool operation{tools.length > 1 ? "s" : ""}</summary>{tools.map(t => <p key={t.id}>{t.status === "completed" ? "✓" : t.status === "failed" ? "!" : "●"} {t.name}</p>)}</details>}{supported("approvals") && Object.values(state.approvals).filter(a => a.sessionId === sessionId).map(a => <ApprovalCard key={a.id + ":" + state.revision} approval={a} online={online}/>)}{supported("questions") && Object.values(state.questions).filter(q => q.sessionId === sessionId).map(q => <QuestionCard key={q.id + ":" + state.revision} question={q} online={online}/>)}{!messages.length && <Empty title="Start a conversation" detail="Tell your agent what you'd like to work on."/>}</>}
      {view === "activity" && <>{tools.length ? tools.map(t => <details className="activity-item" key={t.id}><summary><span className={"badge " + t.status}>{labels[t.status] ?? t.status}</span> {t.name}</summary><pre>{t.preview ?? "No additional details"}</pre><small>{new Date(t.time).toLocaleTimeString()}</small></details>) : <Empty title="No activity yet" detail="Tool execution details will appear here."/>}</>}
      {view === "files" && <><h2>Shared images</h2><div className="image-grid">{messages.flatMap(m => m.images).map(i => <a key={i.id} href={imageUrl(i.id)} target="_blank" rel="noreferrer"><img src={imageUrl(i.id)} alt={i.name} loading="lazy"/><span>{i.name}</span></a>)}</div><p className="muted">Images shared in this conversation. Workspace file browsing is not enabled.</p></>}
      <div ref={tail}/>
    </div>
    {error && <div role="alert" className="error-banner">{error}</div>}
    {view === "conversation" && <form className="composer" onSubmit={e => void send(e)}>{images.length > 0 && <div className="image-tray">{images.map((i, index) => <div key={index}><img src={"data:" + i.mediaType + ";base64," + i.data} alt={i.name}/><button type="button" aria-label={"Remove " + i.name} disabled={sending} onClick={() => setImages(images.filter((_, j) => index !== j))}>×</button></div>)}</div>}<textarea aria-label="Message your agent" placeholder={online ? "What would you like to work on?" : "Reconnect to send a message"} value={text} disabled={!online || sending} onChange={e => setText(e.target.value)} rows={2}/><div className="composer-actions"><div className="composer-options">{supported("models") && models && models.groups.length > 0 && <select aria-label="Model" value={modelValue} disabled={!online || sending || selecting} onChange={e => void pickModel(e.target.value)}>{!modelValue && <option value="">{model ? "Model unavailable" : "Model"}</option>}{models.groups.map(g => <optgroup key={g.id} label={g.name}>{g.models.map(m => <option key={m.id} value={g.id + "/" + m.id}>{m.name}</option>)}</optgroup>)}</select>}{supported("images") && <label className={"icon-button upload " + (!online || sending ? "disabled" : "")} aria-label="Attach image"><Icon name="image"/><input type="file" aria-label="Attach image" accept="image/png,image/jpeg,image/webp,image/gif" multiple disabled={!online || sending} onChange={e => { void upload(e.target.files); e.target.value = ""; }}/></label>}{supported("steer") && <select aria-label="Send mode" value={mode} disabled={!online || sending} onChange={e => setMode(e.target.value as "queue" | "steer")}><option value="queue">Queue</option><option value="steer">Steer</option></select>}</div><div className="actions">{supported("cancel") && state.sessions[sessionId]?.status === "running" && <button type="button" disabled={!online || sending} onClick={() => { void api("/api/cancel", { sessionId }).catch(e => setError(e.message)); }}>Stop</button>}<button className="send-button" aria-label="Send message" disabled={!online || sending || (!text.trim() && !images.length)}><Icon name="send"/></button></div></div><small className="composer-note">{mode === "steer" ? "Steer interrupts the current turn." : "Your message joins the agent's queue."}</small></form>}
  </div>;
}
function Settings({ online }: { online: boolean }) {
  const state = useStore(); const [devices, setDevices] = useState<any[]>([]), [error, setError] = useState(""), [notice, setNotice] = useState(""), [pair, setPair] = useState<{ url: string; expiresAt: number } | undefined>(undefined), [pairing, setPairing] = useState(false);
  let qrSvg = "";
  if (pair) { const code = qrcode(0, "M"); code.addData(pair.url); code.make(); qrSvg = code.createSvgTag(4, 16); }
  useEffect(() => { if (online) void api("/api/devices").then(d => setDevices(d.devices)).catch(e => setError(e.message)); }, [online]);
  async function push() {
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) throw new Error("Push isn't available here. On iPhone, add this app to your Home Screen and open it there.");
      const permission = await Notification.requestPermission(); if (permission !== "granted") throw new Error("Notifications weren't enabled.");
      const registration = await navigator.serviceWorker.ready;
      const { key } = await api("/push/key");
      const bytes = Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
      const subscription = await registration.pushManager.getSubscription() ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
      await api("/push/subscription", subscription.toJSON()); setNotice("Notifications enabled"); setError("");
    } catch (e) { setError((e as Error).message); }
  }
  async function addDevice() {
    setPairing(true);
    try { setPair(await api("/api/pairing", {})); setError(""); }
    catch (e) { setError((e as Error).message); }
    finally { setPairing(false); }
  }
  async function copy(value: string, what: string) {
    try { await navigator.clipboard.writeText(value); setNotice(what + " copied"); setError(""); }
    catch { setError("Couldn't copy. Long-press the text to copy it manually."); }
  }
  return <><div className="page-intro"><div className="eyebrow">MAKE YOURSELF AT HOME</div><h1>Settings.</h1></div><section className="settings-card"><h2>Install DSH Mobile</h2><p>On iPhone, use Safari's Share menu → Add to Home Screen. On Android, choose Install app from the browser menu.</p></section>{state.hello?.capabilities.includes("push") && <section className="settings-card"><h2>Stay in the loop</h2><p>Get notified when your agent needs a decision or finishes a task.</p><button disabled={!online} onClick={() => void push()}>Enable notifications</button></section>}<section className="settings-card"><h2>Paired devices</h2><p>To pair another phone or tablet, create a one-time link here and open it on that device. Links expire after 5 minutes.</p><button disabled={!online || pairing} onClick={() => void addDevice()}>{pairing ? "Creating link…" : "Add device"}</button>{pair && <div className="pair-issue"><div className="pair-qr" role="img" aria-label="Pairing QR code" dangerouslySetInnerHTML={{ __html: qrSvg }}/><span className="pair-url">{pair.url}</span><small className="muted">Expires at {new Date(pair.expiresAt).toLocaleTimeString()}. Scan the code with the other device's camera, open the link there, or paste its code into the pairing screen.</small><div className="pair-actions"><button onClick={() => void copy(pair.url, "Link")}>Copy link</button><button onClick={() => void copy(new URL(pair.url).searchParams.get("t") ?? "", "Code")}>Copy code</button></div></div>}{devices.map(d => <div className="device-row" key={d.id}><span>{d.name}</span><button disabled={!online} onClick={() => { void api("/api/revoke", { id: d.id }).then(() => setDevices(devices.filter(x => x.id !== d.id))).catch(e => setError(e.message)); }}>Revoke</button></div>)}</section>{notice && <p role="status">{notice}</p>}{error && <p role="alert" className="error-text">{error}</p>}<p className="muted">DSH Mobile {GATEWAY_VERSION}</p></>;
}
