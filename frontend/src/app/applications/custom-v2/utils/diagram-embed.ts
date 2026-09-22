// Pure helpers for the drawio embed. They live outside the component because
// every one of them encodes a security or permission decision that has to be
// testable without a DOM (the v2 specs run in `environment: node`).

// Build the drawio embed URL.
//
// READ-ONLY. drawio's embed protocol has no `editable=0`; `chrome=0` is the
// documented way to mount the VIEWER instead of the editor, and it is what the
// diagrams.net "Embed > Viewer" snippet emits. Without it the canvas is fully
// editable no matter what the server said, and a user with read-only access
// could edit for twenty minutes and lose every change with no feedback (#497).
//
// `autosave=1` is dropped in the same breath: leaving it on would have drawio
// post save events we can only throw away, which is how the loss stayed silent.
export function buildEditorSrc(editorUrl: string, isWritable: boolean): string {
  const params = ['embed=1', 'spin=1', 'proto=json', ...(isWritable ? ['autosave=1'] : ['chrome=0']), 'keepmodified=1', 'dark=1']
  return `${editorUrl}?${params.join('&')}`
}
