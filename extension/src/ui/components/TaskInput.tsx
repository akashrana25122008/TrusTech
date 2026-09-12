import { useState } from "react";
import { ArrowRight } from "lucide-react";

const SUGGESTIONS = [
  "Find a beginner C language tutorial on YouTube",
  "Compare products",
  "Fill a form",
];

export function TaskInput({
  onSubmit,
  disabled,
}: {
  onSubmit: (task: string) => void;
  disabled: boolean;
}) {
  const [task, setTask] = useState("");

  const submit = (t?: string) => {
    const value = (t ?? task).trim();
    if (!value || disabled) return;
    onSubmit(value);
    setTask("");
  };

  return (
    <section className="composer" aria-label="Start a task">
      <div className="composer__row">
        <label className="sr-only" htmlFor="task-composer">
          Describe a task for the agent
        </label>
        <textarea
          id="task-composer"
          className="composer__field"
          rows={2}
          value={task}
          onChange={(e) => setTask(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="What should I do?"
          disabled={disabled}
        />
        <button
          type="button"
          className="composer__run"
          onClick={() => submit()}
          disabled={disabled || task.trim().length === 0}
        >
          <span>Run</span>
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="chips chips--minimal">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="chip" onClick={() => submit(s)} disabled={disabled}>
            {s}
          </button>
        ))}
      </div>
    </section>
  );
}