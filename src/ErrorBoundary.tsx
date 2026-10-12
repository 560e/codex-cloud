import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string; compact?: boolean },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidUpdate(previous: Readonly<typeof this.props>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey)
      this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={this.props.compact ? 'render-recovery notice' : 'app-recovery'} role="alert">
        <strong>{this.props.compact ? '这段消息暂时无法显示' : '页面显示遇到问题'}</strong>
        <p>会话记录仍保存在服务器，未发送的草稿会保留。</p>
        <div className="button-row">
          <button className="secondary" onClick={() => this.setState({ failed: false })}>
            重新显示
          </button>
          <button className="text-button" onClick={() => location.reload()}>
            刷新页面
          </button>
        </div>
      </div>
    );
  }
}
