import {Stack, Text, Button, Modal, ToolbarSection} from './elements';
import {useStore, setState} from './store';
import {getHost} from './hostApi';

/**
 * The UI this plugin contributes *into the host chrome* via remote-dom. None of
 * this renders inside the iframe — the host maps each element to its own
 * component and portals the toolbar section into the nav and the modal into a
 * whole-window overlay. Props, children, and the press/close events all cross
 * the cross-origin boundary.
 */
export function Contributions() {
  const modalOpen = useStore((s) => s.modalOpen);

  return (
    <>
      <ToolbarSection label="Notes plugin">
        <Button tone="primary" onPress={() => setState({modalOpen: true})}>
          Open details
        </Button>
        <Button onPress={() => void getHost().toast('Saved ✓', {tone: 'success'})}>
          Quick save
        </Button>
      </ToolbarSection>

      <Modal
        open={modalOpen}
        heading="Plugin details (rendered by the host)"
        onClose={() => setState({modalOpen: false})}
      >
        <Stack gap={12}>
          <Text>
            This modal's content is defined by the plugin but rendered by the
            host outside the iframe, so it covers the whole window — something an
            iframe can never do on its own.
          </Text>
          <Text tone="subdued">
            The component tree, its props, and the close event all cross the
            origin boundary through remote-dom.
          </Text>
          <Button tone="primary" onPress={() => setState({modalOpen: false})}>
            Got it
          </Button>
        </Stack>
      </Modal>
    </>
  );
}
