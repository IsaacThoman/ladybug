export default function RedirectChain({ chain }: { chain: string[] }) {
  if (chain.length === 0) return null;
  return (
    <section className="panel" aria-label="Redirect chain">
      <h2 className="panel-title">
        Redirect chain{" "}
        <span className="count">
          {chain.length} hop{chain.length === 1 ? "" : "s"}
        </span>
      </h2>
      <ol className="chain">
        {chain.map((url, i) => (
          <li key={`${i}-${url}`} className={i === chain.length - 1 ? "is-final" : undefined}>
            <span className="chain-index">{i === chain.length - 1 ? "final" : i + 1}</span>
            <span className="mono chain-url">{url}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
