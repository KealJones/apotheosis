import CoreGraphics

struct IdleGate {
    /// Returns true when there has been no mouse or keyboard input for `seconds`.
    static func isIdle(after seconds: Int) -> Bool {
        let secondsSinceMouse = CGEventSource.secondsSinceLastEventType(
            .combinedSessionState,
            eventType: .mouseMoved
        )
        let secondsSinceKey = CGEventSource.secondsSinceLastEventType(
            .combinedSessionState,
            eventType: .keyDown
        )
        return min(secondsSinceMouse, secondsSinceKey) > Double(seconds)
    }
}
