export interface DeterministicEmbeddingProvider {
  readonly modelId: string;
  readonly modelRevision: string;
  embed(texts: readonly string[]): Promise<readonly number[][]>;
}

export function deterministicEmbeddings(
  rules: Readonly<Record<string, readonly number[]>>,
): DeterministicEmbeddingProvider {
  return {
    modelId: "test/deterministic-e5",
    modelRevision: "test-revision",
    async embed(texts) {
      return texts.map((text) => {
        const match = Object.entries(rules).find(([needle]) =>
          text.toLocaleLowerCase("en").includes(needle.toLocaleLowerCase("en")),
        );
        if (!match) return [0, 0];
        return [...match[1]];
      });
    },
  };
}
