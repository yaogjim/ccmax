import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentDefinition } from '../../api/agents'
import { useSettingsStore } from '../../stores/settingsStore'
import { AgentRuntimeSection, formatAgentRuntime } from './AgentRuntimePanel'

function makeAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    agentType: 'code_reviewer',
    description: 'Review code',
    source: 'userSettings',
    baseDir: '/Users/test/.claude/agents',
    isActive: true,
    editable: true,
    ...overrides,
  }
}

describe('formatAgentRuntime', () => {
  it('joins a living provider name with the model', () => {
    expect(formatAgentRuntime({
      providerId: 'provider-a',
      providerName: 'Provider A',
      modelId: 'model-a',
      source: 'userSettings',
    })).toBe('Provider A · model-a')
  })

  it('drops a vanished provider id so the badge only shows the model', () => {
    // A missing provider has no name. Showing the raw id is noise; the status
    // badge already says why the pin is unusable.
    expect(formatAgentRuntime({
      providerId: 'gone',
      modelId: 'model-a',
      source: 'userSettings',
    })).toBe('model-a')
  })
})

describe('AgentRuntimeSection', () => {
  beforeEach(() => {
    useSettingsStore.setState({ locale: 'en' })
  })

  it('offers to pin an unbound agent', () => {
    render(
      <AgentRuntimeSection
        agent={makeAgent()}
        onEdit={vi.fn()}
        onClear={vi.fn()}
        clearing={false}
        error={null}
      />,
    )

    const section = screen.getByRole('region', { name: 'Runtime' })
    expect(section).toHaveTextContent(/Not pinned/)
    expect(screen.getByRole('button', { name: 'Pin runtime' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
  })

  it('shows the pinned pair, status, and change/clear actions', () => {
    render(
      <AgentRuntimeSection
        agent={makeAgent({
          runtime: {
            providerId: 'provider-a',
            providerName: 'Provider A',
            modelId: 'model-a',
            source: 'userSettings',
          },
          runtimeStatus: 'valid',
        })}
        onEdit={vi.fn()}
        onClear={vi.fn()}
        clearing={false}
        error={null}
      />,
    )

    expect(screen.getByTestId('agent-runtime-value')).toHaveTextContent('Provider A · model-a')
    expect(screen.getByText('Available')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
  })

  it('hides edit actions when a managed policy owns the pin', () => {
    render(
      <AgentRuntimeSection
        agent={makeAgent({
          runtime: {
            providerId: 'provider-a',
            providerName: 'Provider A',
            modelId: 'model-a',
            source: 'policySettings',
          },
          runtimeStatus: 'valid',
        })}
        onEdit={vi.fn()}
        onClear={vi.fn()}
        clearing={false}
        error={null}
      />,
    )

    expect(screen.getByTestId('agent-runtime-value')).toHaveTextContent('Provider A · model-a')
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument()
    expect(screen.getByText(/managed by Managed settings/)).toBeInTheDocument()
  })
})