import {usePlatform} from './platform';
import {useStore, setState} from './store';

/**
 * The surfaces this plugin contributes beyond its own page: a toolbar section
 * and a whole-window modal. Written once against the platform's component kit —
 * hosted, these are remote-dom elements the host renders into its chrome;
 * standalone, they're local components the plugin renders into its own chrome.
 */
export function Contributions() {
  const platform = usePlatform();
  const {Toolbar, Modal, Button, Stack, Text} = platform.components;
  const modalOpen = useStore((s) => s.modalOpen);

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
