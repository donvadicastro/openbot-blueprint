import { useState, type FormEvent, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { stashFirstMessage } from "@/components/channels/transcript-messages";
import { Button } from "@/components/ui/button";
import { channelKeys, type AgentChannel } from "@/lib/channels/queries";
import { tryClient } from "@/lib/client";
import { isSetupAnswer, validateSetup } from "@/lib/team-setup/setup-form";
import { ProjectFolderPicker } from "./project-folder-picker";

export function TeamSetupGate({ channel, children }: { channel: AgentChannel; children: ReactNode }) {
  const [submitted, setSubmitted] = useState(false);
  const setup = channel.teamSetup;
  if (!setup || setup.complete || submitted) return children;

  return <TeamSetupForm
    form={setup.form}
    channelId={channel.id}
    onCompleted={() => setSubmitted(true)}
  />;
}

function TeamSetupForm({
  form, channelId, onCompleted,
}: {
  form: NonNullable<AgentChannel["teamSetup"]>["form"];
  channelId: string;
  onCompleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const { questions } = form;
  const remaining = questions.filter(question => !isSetupAnswer(question, answers[question.id])).length;
  const ready = Boolean(validateSetup(form, { answers }).value);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || pending) return;
    setPending(true);
    setError("");
    try {
      const response = await tryClient(`/api/channels/${encodeURIComponent(channelId)}/team-setup`, {
        method: "POST",
        body: { answers },
      });
      if (!response.ok) {
        const details = await response.json().catch(() => null);
        throw new Error(details?.error ?? "Couldn’t save your setup. Try again.");
      }
      const saved = await response.json() as { answers: Record<string, string> };
      const summary = questions
        .map(({ id, question }) => `Q: ${question}\nA: ${saved.answers[id]}`)
        .join("\n\n");
      stashFirstMessage(channelId, `Here are the starting artifacts for discovery.\n\n${summary}`);
      onCompleted();
      void queryClient.invalidateQueries({ queryKey: channelKeys.detail(channelId) });
      void queryClient.invalidateQueries({ queryKey: ["blueprint-team-projects"] });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn’t save your setup. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <form className="mx-auto max-w-2xl space-y-6 px-6 py-8" onSubmit={submit}>
        <div>
          <p className="text-sm font-medium text-muted-foreground">Team Lead</p>
          <h1 className="mt-1 text-2xl font-semibold">Set up your team</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Provide the starting artifacts. The team will work out what you need in the conversation.
          </p>
        </div>
        <fieldset className="space-y-4" disabled={pending}>
          <legend className="mb-2 text-sm font-medium">Required artifacts</legend>
          {questions.map(({ id, question, format }) => format === "project-source" ? (
            <ProjectFolderPicker key={id} value={answers[id] ?? ""}
              onChange={url => setAnswers(current => ({ ...current, [id]: url }))} />
          ) : (
            <label className="block space-y-1.5" key={id}>
              <span className="block text-sm font-medium">{question}</span>
              <textarea className="block min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-sm focus-visible:outline-2"
                maxLength={2000} required rows={2} value={answers[id] ?? ""}
                placeholder={format === "folder" ? "/absolute/path/to/project" : undefined}
                onChange={event => setAnswers({ ...answers, [id]: event.target.value })} />
              {format === "folder" && <span className="text-xs text-muted-foreground">
                Enter the full path to the project folder.
              </span>}
            </label>
          ))}
        </fieldset>
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={!ready || pending}>{pending ? "Saving…" : "Finish setup and open chat"}</Button>
          <Button type="button" variant="ghost" disabled={pending} onClick={() => {
            setAnswers({});
            setError("");
          }}>Clear answers</Button>
          <p className="text-sm text-muted-foreground" role="status">
            {remaining ? `${remaining} required ${remaining === 1 ? "artifact" : "artifacts"} remaining.` : "All required artifacts are provided."}
          </p>
        </div>
      </form>
    </div>
  );
}
