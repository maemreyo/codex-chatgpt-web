/** A visible assistant-turn text signal, not proof of a ChatGPT safety decision. */
export function chatGptSafetyStatusTextVisible(text: string): boolean {
  return /This tool call was blocked by OpenAI because we couldn['’]t determine the safety status of the request\.?/i.test(text);
}
