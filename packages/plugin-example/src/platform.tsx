import {createContext, useContext} from 'react';
import type {ComponentType, ReactNode} from 'react';
import type {AppSummary, CommandDescriptor, ToastOptions} from '@ff/protocol';

/**
 * The set of surface components the plugin's feature code renders. The plugin is
 * written once against this kit; the active {@link Platform} supplies either the
 * remote-dom implementations (rendered by the host) or local implementations
 * (rendered by the plugin's own standalone chrome).
 */
export interface ComponentKit {
  Toolbar: ComponentType<{label?: string; children?: ReactNode}>;
  Modal: ComponentType<{
    open?: boolean;
    heading?: string;
    onClose?: () => void;
    children?: ReactNode;
  }>;
  Button: ComponentType<{
    tone?: 'default' | 'primary' | 'critical';
    disabled?: boolean;
    onPress?: () => void;
    children?: ReactNode;
  }>;
  Stack: ComponentType<{
    direction?: 'vertical' | 'horizontal';
    gap?: number;
    children?: ReactNode;
  }>;
  Text: ComponentType<{tone?: 'default' | 'subdued'; children?: ReactNode}>;
}

/**
 * The capabilities available to the plugin, abstracted over whether it runs
 * inside the host chrome or standalone. Methods present in both modes are
 * required; capabilities that only exist when hosted are optional, so feature
 * code must check for them and degrade gracefully when absent.
 */
export interface Platform {
  readonly mode: 'hosted' | 'standalone';
  toast(message: string, options?: ToastOptions): void;
  setCommands(commands: CommandDescriptor[]): void;
  readonly components: ComponentKit;
  /** Host-only: sibling apps in the shell. Undefined when standalone. */
  readonly listApps?: () => Promise<AppSummary[]>;
  /** Host-only: bring a sibling app to the foreground. Undefined when standalone. */
  readonly switchApp?: (appId: string) => void;
}

const PlatformContext = createContext<Platform | null>(null);
export const PlatformProvider = PlatformContext.Provider;

export function usePlatform(): Platform {
  const platform = useContext(PlatformContext);
  if (!platform) {
    throw new Error('usePlatform must be used within a PlatformProvider');
  }
  return platform;
}
