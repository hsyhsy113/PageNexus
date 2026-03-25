import { Button, Card, Input, Space, Switch, Tag, Typography } from "antd";
import type { AppSettings, ModelHealth } from "../../lib/types";
import {
  Activity,
  ArrowLeft,
  FolderOpen,
  Globe,
  Key,
  RefreshCcw,
  Settings,
  Terminal,
} from "lucide-react";

interface Props {
  settings: AppSettings;
  health: ModelHealth;
  diagnostics: string[];
  storagePath: string;
  isSavingSettings: boolean;
  onBack: () => void;
  onUpdateSettings: (update: (current: AppSettings) => AppSettings) => void;
  onPickStorageDir: () => void;
  onSaveSettings: () => void;
  onRefreshHealth: () => void;
}

export function SettingsView(props: Props) {
  const useEmbeddingApi = props.settings.embedding_mode.trim() === "api";

  return (
    <div className="flex-1 overflow-y-auto rounded-[2rem] bg-white/40 p-8 backdrop-blur-3xl">
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-8 flex items-center justify-between gap-5">
          <Space size={12}>
            <Button shape="circle" icon={<ArrowLeft className="h-4 w-4" />} onClick={props.onBack} />
            <Typography.Title level={2} style={{ margin: 0 }}>
              Settings
            </Typography.Title>
          </Space>
          <Tag color={props.health.backend_status === "online" ? "success" : "error"}>
            {props.health.backend_status === "online" ? "Connection Active" : "Connection Issue"}
          </Tag>
        </div>

        <div className="hero-card mb-6 rounded-[1.6rem] px-5 py-4">
          <div className="text-[10px] font-black uppercase tracking-[0.26em] text-slate-400">Runtime Profile</div>
          <div className="mt-2 text-sm font-semibold text-slate-600">
            统一管理 Agent、Embedding、解析服务与本地存储路径，保存后会自动重连 Agent。
          </div>
        </div>

        <div className="mb-8 grid grid-cols-1 gap-6 md:grid-cols-2">
          <Card
            title={
              <Space size={10}>
                <Globe className="h-4 w-4" />
                <span>Agent 模型配置</span>
              </Space>
            }
            variant="borderless"
          >
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Typography.Text type="secondary">API URL</Typography.Text>
              <Input
                value={props.settings.packy_api_base_url}
                onChange={(event) =>
                  props.onUpdateSettings((current) => ({ ...current, packy_api_base_url: event.target.value }))
                }
                placeholder="https://www.packyapi.com/v1"
              />

              <Typography.Text type="secondary">Model Name</Typography.Text>
              <Input
                value={props.settings.packy_model_id}
                onChange={(event) =>
                  props.onUpdateSettings((current) => ({ ...current, packy_model_id: event.target.value }))
                }
                placeholder="gpt-5.4-low"
              />

              <Typography.Text type="secondary">API Key</Typography.Text>
              <Input.Password
                value={props.settings.packy_api_key}
                onChange={(event) =>
                  props.onUpdateSettings((current) => ({ ...current, packy_api_key: event.target.value }))
                }
                placeholder="sk-..."
              />
            </Space>
          </Card>

          <Card
            title={
              <Space size={10}>
                <Settings className="h-4 w-4" />
                <span>Embedding 配置</span>
              </Space>
            }
            variant="borderless"
          >
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Space size={8}>
                <Typography.Text>启用语义检索</Typography.Text>
                <Switch
                  checked={props.settings.semantic_search_enabled}
                  onChange={(checked) =>
                    props.onUpdateSettings((current) => ({ ...current, semantic_search_enabled: checked }))
                  }
                />
              </Space>

              <Typography.Text type="secondary">Embedding 后端</Typography.Text>
              <Space>
                <Button
                  type={!useEmbeddingApi ? "primary" : "default"}
                  onClick={() => props.onUpdateSettings((current) => ({ ...current, embedding_mode: "" }))}
                >
                  本地优先
                </Button>
                <Button
                  type={useEmbeddingApi ? "primary" : "default"}
                  onClick={() => props.onUpdateSettings((current) => ({ ...current, embedding_mode: "api" }))}
                >
                  API
                </Button>
              </Space>

              {useEmbeddingApi ? (
                <>
                  <Typography.Text type="secondary">Embedding API Base URL</Typography.Text>
                  <Input
                    value={props.settings.embedding_api_base_url}
                    onChange={(event) =>
                      props.onUpdateSettings((current) => ({ ...current, embedding_api_base_url: event.target.value }))
                    }
                    placeholder="https://www.packyapi.com/v1"
                  />

                  <Typography.Text type="secondary">Embedding API Model</Typography.Text>
                  <Input
                    value={props.settings.embedding_model_id}
                    onChange={(event) =>
                      props.onUpdateSettings((current) => ({ ...current, embedding_model_id: event.target.value }))
                    }
                    placeholder="text-embedding-3-small"
                  />

                  <Typography.Text type="secondary">Embedding API Key</Typography.Text>
                  <Input.Password
                    value={props.settings.embedding_api_key}
                    onChange={(event) =>
                      props.onUpdateSettings((current) => ({ ...current, embedding_api_key: event.target.value }))
                    }
                    placeholder="sk-..."
                  />
                </>
              ) : (
                <>
                  <Typography.Text type="secondary">本地 Embedding Model ID</Typography.Text>
                  <Input
                    value={props.settings.embedding_local_model_id}
                    onChange={(event) =>
                      props.onUpdateSettings((current) => ({ ...current, embedding_local_model_id: event.target.value }))
                    }
                    placeholder="google/embeddinggemma-300m"
                  />
                  <Typography.Text type="secondary">
                    本地模式下不依赖 embedding API；若同时配置本地和 API 且未显式选择，默认走本地。
                  </Typography.Text>
                </>
              )}
            </Space>
          </Card>

          <Card
            title={
              <Space size={10}>
                <Key className="h-4 w-4" />
                <span>MinerU 配置</span>
              </Space>
            }
            variant="borderless"
          >
            <Space direction="vertical" size={12} style={{ width: "100%" }}>
              <Typography.Text type="secondary">MinerU API Token</Typography.Text>
              <Input.Password
                value={props.settings.mineru_api_token}
                onChange={(event) =>
                  props.onUpdateSettings((current) => ({ ...current, mineru_api_token: event.target.value }))
                }
                placeholder="MinerU Secret..."
              />

              <Typography.Text type="secondary">Storage Directory</Typography.Text>
              <Input
                value={props.settings.storage_dir}
                onChange={(event) =>
                  props.onUpdateSettings((current) => ({ ...current, storage_dir: event.target.value }))
                }
                placeholder={`留空使用默认目录: ${props.storagePath}`}
              />

              <Button icon={<FolderOpen className="h-4 w-4" />} onClick={props.onPickStorageDir}>
                选择目录
              </Button>
            </Space>
          </Card>
        </div>

        <Space className="mb-6">
          <Button
            type="primary"
            icon={<Settings className="h-4 w-4" />}
            loading={props.isSavingSettings}
            onClick={props.onSaveSettings}
          >
            保存设置
          </Button>
          <Button icon={<RefreshCcw className="h-4 w-4" />} onClick={props.onRefreshHealth}>
            重新健康检查
          </Button>
        </Space>

        <Card
          title={
            <Space size={10}>
              <Terminal className="h-4 w-4" />
              <span>Diagnostics</span>
            </Space>
          }
          extra={
            <Space>
              <Activity className="h-4 w-4 text-emerald-500" />
              <Typography.Text type="secondary">{props.health.detail}</Typography.Text>
            </Space>
          }
          variant="borderless"
        >
          <div className="soft-scrollbar h-72 space-y-2 overflow-y-auto rounded-2xl bg-slate-900 p-6 font-mono text-[11px] text-slate-400">
            {props.diagnostics.length === 0 ? (
              <div className="text-slate-500">[INFO] 暂无日志。</div>
            ) : (
              props.diagnostics.map((entry) => (
                <div key={entry} className="text-slate-300">
                  {entry}
                </div>
              ))
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
