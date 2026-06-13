import {useEffect} from 'react';
import {usePlatform} from './platform';
import {useStore, setState} from './store';

/**
 * The surfaces this plugin contributes beyond its own page: a toolbar section, a
 * whole-window modal, and command-palette entries. Written once against the
 * platform's component kit — hosted, the toolbar/modal are remote-dom elements
 * the host renders into its chrome; standalone, they're local components the
 * plugin renders into its own chrome. Commands are registered in an effect, so
 * they're tied to this component's lifecycle (and cleared on unmount).
 */
export function Contributions() {
  const platform = usePlatform();
  const {Toolbar, Modal, Button, Stack, Text} = platform.components;
  const modalOpen = useStore((s) => s.modalOpen);

  useEffect(() => {
    platform.setCommands([
      {
        id: 'notes.hello',
        title: 'Notes: Say hello',
        subtitle: 'Show a toast',
        run: () =>
          platform.toast('👋 Hello from the example plugin!', {
            tone: 'success',
          }),
      },
      {
        id: 'notes.details',
        title: 'Notes: Open details',
        subtitle: 'Open the details modal',
        run: () => setState({modalOpen: true}),
      },
    ]);
    return () => platform.setCommands([]);
  }, [platform]);

  return (
    <>
      <Toolbar label="Notes plugin">
        <Button tone="primary" onPress={() => setState({modalOpen: true})}>
          Open details
        </Button>
        <Button onPress={() => platform.toast('Saved ✓', {tone: 'success'})}>
          Quick save
        </Button>
      </Toolbar>

      <Modal
        open={modalOpen}
        heading={
          platform.mode === 'hosted'
            ? 'Plugin details (rendered by the host)'
            : 'Plugin details (rendered by the app)'
        }
        onClose={() => setState({modalOpen: false})}
      >
        <Stack gap={12}>
          <Text>
            {platform.mode === 'hosted'
              ? "This modal's content is defined by the plugin but rendered by the host outside the iframe, so it covers the whole window."
              : "Running standalone, the plugin renders this whole-window modal itself — no host required."}
          </Text>
          <Text tone="subdued">
            The same feature code drives both modes; only the component kit
            behind it differs.
          </Text>
          <Button tone="primary" onPress={() => setState({modalOpen: false})}>
            Got it
          </Button>
        </Stack>
      </Modal>
    </>
  );
}
