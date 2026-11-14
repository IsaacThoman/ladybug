export type BubbleTone = "chat" | "ok" | "warn" | "danger";

/**
 * What the ladybug is saying. Pops in again whenever the text changes. The
 * trailing dots point down and to the left, toward the bug's head.
 */
export default function SpeechBubble({
  text,
  tone = "chat",
  tail = "left",
  className,
}: {
  text: string;
  tone?: BubbleTone;
  /** Which side the trailing dots sit on. */
  tail?: "left" | "right";
  className?: string;
}) {
  return (
    <p key={text} className={className ? `bubble ${className}` : "bubble"} data-tone={tone} data-tail={tail}>
      {text}
    </p>
  );
}
