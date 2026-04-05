import { useEffect, useRef } from 'react'
import {
  getTerminalFocusState,
  subscribeTerminalFocus,
} from '../ink/terminal-focus-state.js'
import { generateAwaySummary } from '../services/awaySummary.js'
import type { Message } from '../types/message.js'
import { createAwaySummaryMessage } from '../utils/messages.js'

// Fire after 5 minutes of inactivity — long enough to be meaningful,
// short enough that the summary is still fresh when the user returns.
const BLUR_DELAY_MS = 5 * 60_000

type SetMessages = (updater: (prev: Message[]) => Message[]) => void

function hasSummarySinceLastUserTurn(messages: readonly Message[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.type === 'user' && !m.isMeta && !m.isCompactSummary) return false
    if (m.type === 'system' && m.subtype === 'away_summary') return true
  }
  return false
}

/**
 * Appends a "while you were away" summary card after the terminal has been
 * blurred for 5 minutes. Fires only when:
 *   (a) 5 min have passed since blur
 *   (b) no turn is in progress
 *   (c) no away_summary already exists since the last user message
 *
 * Focus state 'unknown' (terminal doesn't support DECSET 1004) is a no-op.
 */
export function useAwaySummary(
  messages: readonly Message[],
  setMessages: SetMessages,
  isLoading: boolean,
): void {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const messagesRef = useRef(messages)
  const isLoadingRef = useRef(isLoading)
  const pendingRef = useRef(false)
  const generateRef = useRef<(() => Promise<void>) | null>(null)

  messagesRef.current = messages
  isLoadingRef.current = isLoading

  useEffect(() => {
    function clearTimer(): void {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    function abortInFlight(): void {
      abortRef.current?.abort()
      abortRef.current = null
    }

    async function generate(): Promise<void> {
      pendingRef.current = false
      if (hasSummarySinceLastUserTurn(messagesRef.current)) return
      abortInFlight()
      const controller = new AbortController()
      abortRef.current = controller
      const text = await generateAwaySummary(messagesRef.current, controller.signal)
      if (controller.signal.aborted || text === null) return
      setMessages(prev => [...prev, createAwaySummaryMessage(text)])
    }

    function onBlurTimerFire(): void {
      timerRef.current = null
      if (isLoadingRef.current) {
        // Agent is mid-turn — defer until turn completes
        pendingRef.current = true
        return
      }
      void generate()
    }

    function onFocusChange(): void {
      const state = getTerminalFocusState()
      if (state === 'blurred') {
        clearTimer()
        timerRef.current = setTimeout(onBlurTimerFire, BLUR_DELAY_MS)
      } else if (state === 'focused') {
        clearTimer()
        abortInFlight()
        pendingRef.current = false
      }
      // 'unknown' → terminal doesn't support focus events, no-op
    }

    const unsubscribe = subscribeTerminalFocus(onFocusChange)
    // Handle the case where we're already blurred when the effect mounts
    onFocusChange()
    generateRef.current = generate

    return () => {
      unsubscribe()
      clearTimer()
      abortInFlight()
      generateRef.current = null
    }
  }, [setMessages])

  // Timer fired mid-turn → fire now that the turn has ended (if still blurred)
  useEffect(() => {
    if (isLoading) return
    if (!pendingRef.current) return
    if (getTerminalFocusState() !== 'blurred') return
    void generateRef.current?.()
  }, [isLoading])
}
