import { Button, Input, Modal, Space, Typography } from "antd";
import type { InputRef } from "antd";
import type { RefObject } from "react";

interface Props {
  open: boolean;
  value: string;
  loading: boolean;
  inputRef: RefObject<InputRef>;
  onChange: (value: string) => void;
  onCancel: () => void;
  onCreate: () => void;
}

export function CreateWorkspaceModal(props: Props) {
  return (
    <Modal
      title="Create Workspace"
      open={props.open}
      onCancel={props.onCancel}
      footer={
        <Space>
          <Button onClick={props.onCancel}>取消</Button>
          <Button
            type="primary"
            loading={props.loading}
            disabled={!props.value.trim()}
            onClick={props.onCreate}
          >
            创建 Workspace
          </Button>
        </Space>
      }
      destroyOnClose
    >
      <Space direction="vertical" size={12} style={{ width: "100%" }}>
        <Typography.Text type="secondary">Start a new local workspace</Typography.Text>
        <Input
          ref={props.inputRef}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          onPressEnter={props.onCreate}
          placeholder="例如：澳洲地产法"
        />
      </Space>
    </Modal>
  );
}
