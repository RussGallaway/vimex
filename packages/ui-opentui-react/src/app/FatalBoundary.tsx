import { Component, type ErrorInfo, type ReactNode } from "react"

export interface FatalBoundaryProps {
  children?: ReactNode
  onFatal(error: Error, info: ErrorInfo): void
}

/** Reports fatal React failures before OpenTUI's outer display-only boundary catches them. */
export class FatalBoundary extends Component<FatalBoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }

  componentDidCatch(error: Error, info: ErrorInfo): void { this.props.onFatal(error, info) }

  render(): ReactNode { return this.state.failed ? null : this.props.children }
}
