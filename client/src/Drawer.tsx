// Read-only view of a workspace file a comment links to.

interface Props {
  path: string;
  content: string;
  onClose: () => void;
}

export function Drawer({ path, content, onClose }: Props) {
  return (
    <div className="drawer">
      <div className="drawer-head">
        <span className="muted small">{path}</span>
        <button className="link" onClick={onClose}>Close</button>
      </div>
      <pre className="drawer-body">{content}</pre>
    </div>
  );
}
