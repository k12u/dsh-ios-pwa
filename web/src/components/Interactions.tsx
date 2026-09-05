import { useState } from "react";
import type { Approval, Question } from "@dsh-mobile/domain";
import { api } from "../api/gateway-client";
export function ApprovalCard({ approval, online }: { approval: Approval; online: boolean }) {
  const [sending, setSending] = useState(false), [error, setError] = useState("");
  async function answer(outcome: "allowed-once" | "rejected") {
    setSending(true); setError("");
    try { await api("/api/approval", { id: approval.id, sessionId: approval.sessionId, outcome }); }
    catch (e) { setError((e as Error).message); setSending(false); }
    // A receipt does not resolve the approval. Only a gateway event does.
  }
  return <section className="interaction approval" aria-label="Approval required"><div className="eyebrow">Approval required</div><h3>{approval.toolName}</h3><p>{approval.reason}</p>{approval.argumentsPreview && <pre>{approval.argumentsPreview}</pre>}{approval.state === "pending" ? <><div className="actions"><button className="primary" disabled={!online || sending} onClick={() => void answer("allowed-once")}>Allow once</button><button disabled={!online || sending} onClick={() => void answer("rejected")}>Reject</button></div>{sending && <small>Waiting for confirmation…</small>}</> : <p className="resolved">{approval.state}</p>}{error && <p role="alert">{error}</p>}</section>;
}
export function QuestionCard({ question, online }: { question: Question; online: boolean }) {
  const [answers, setAnswers] = useState<Record<string, { selected: string[]; custom: string }>>({});
  const [sending, setSending] = useState(false), [error, setError] = useState("");
  const pending = question.state === "pending";
  const valid = question.fields.every(q => answers[q.id]?.selected.length || answers[q.id]?.custom.trim());
  return <form className="interaction question" onSubmit={e => {
    e.preventDefault(); setSending(true); setError("");
    void api("/api/question", { id: question.id, sessionId: question.sessionId, answers: question.fields.map(q => ({ id: q.id, selected: answers[q.id]?.selected ?? [], ...(answers[q.id]?.custom.trim() ? { custom: answers[q.id].custom.trim() } : {}) })) }).catch(e => { setError(e.message); setSending(false); });
  }}><div className="eyebrow">Your input is needed</div>{question.fields.map(q => {
    const value = answers[q.id] ?? { selected: [], custom: "" };
    const update = (next: typeof value) => setAnswers(prev => ({ ...prev, [q.id]: next }));
    return <fieldset key={q.id} disabled={!online || sending || !pending}><legend>{q.title}</legend>{q.detail && <p>{q.detail}</p>}{q.options.map(o => <label className="choice" key={o.id}><input type={q.multiple ? "checkbox" : "radio"} name={q.id} checked={value.selected.includes(o.id)} onChange={() => update({ selected: q.multiple ? value.selected.includes(o.id) ? value.selected.filter(id => id !== o.id) : [...value.selected, o.id] : [o.id], custom: q.multiple ? value.custom : "" })} /><span>{o.label}{o.description && <small>{o.description}</small>}</span></label>)}<textarea aria-label={"Custom answer: " + q.title} placeholder="Or write your own answer…" value={value.custom} onChange={e => update({ selected: q.multiple ? value.selected : [], custom: e.target.value })} /></fieldset>;
  })}{pending ? <button className="primary" disabled={!online || !valid || sending}>{sending ? "Waiting for confirmation…" : "Send answer"}</button> : <p className="resolved">{question.state}</p>}{error && <p role="alert">{error}</p>}</form>;
}
