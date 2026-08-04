# Unity → Quarks 导出（CFXR Fire Explosion）

目标：在 Unity 里把 `CFXR3 Fire Explosion B` 导出为 Quarks JSON，放到本仓库 `public/assets/quarks/`，用 WebGL 播放器加载。

## 1. 安装导出器（任选其一）

### 推荐：复制 Editor 脚本

把本目录下的 `Editor/` 整夹复制到你的 Unity 工程：

```
你的Unity工程/Assets/QuarksExporter/Editor/
  BabylonQuarks.UnityExporter.Editor.asmdef
  ExportContext.cs
  Json.cs
  ParticleConverter.cs
  QuarksExporter.cs
  ValueConverter.cs
```

或在仓库根目录执行（把路径换成你的 Unity 工程）：

```bash
npm run setup:quarks-exporter -- "/绝对路径/到/Unity工程"
```

回到 Unity 等脚本编译完成。菜单应出现：

- **Tools → Quarks → Export Selected Effect to JSON**
- **Tools → Quarks → Diagnose Exporter Version**（应显示 `unity-quarks-exporter@cfxr-2`）

### 如何确认 Unity 用的是新脚本（不是 bug）

你最近导出的 JSON 若是：

```json
"metadata": { "generator": "unity-quark-exporter" }
```

且 `materials[]` **没有** `name` / `cfxr` → 这是**旧导出器**在跑（不是 `BuildCfxr` 条件失败）。

新脚本导出后必须是：

```json
"metadata": { "generator": "unity-quarks-exporter@cfxr-2" }
```

且每个 material 有 `"name"` 和（CFXR 材质）`"cfxr"`。

若菜单里没有 Diagnose / 导出后仍是旧 generator：

1. 确认打开的是装了脚本的工程（本仓库为 `unity-ref`）
2. Project 窗口打开 `Assets/QuarksExporter/Editor/ExportContext.cs`，搜索 `BuildCfxrMaterialBlock`——没有就是旧文件
3. 再跑一次：`npm run setup:quarks-exporter -- "/你的Unity工程路径"`
4. Unity：**Assets → Reimport All** 或删 `Library/ScriptAssemblies` 后重开，强制重编译
5. Console 导出日志应含 `[Quarks Exporter] unity-quarks-exporter@cfxr-2`

### 备选：.unitypackage

从 [babylon.quarks-standalone Releases](https://github.com/Soullnik/babylon.quarks-standalone/releases/latest) 下载 `BabylonQuarksUnityExporter.unitypackage`，在 Unity 里 **Assets → Import Package → Custom Package…**。

需要 Unity **2020.3+**，工程内需已导入 Cartoon FX Remaster（CFXR）。

## 2. 导出 Fire Explosion

1. 打开含 CFXR 的场景，或把 Prefab 拖进 Hierarchy：  
   `CFXR Prefabs/Explosions/CFXR3 Fire Explosion B`
2. **选中根物体** `CFXR3 Fire Explosion B`（不要只选子层）
3. 菜单 **Tools → Quarks → Export Selected Effect to JSON**
4. 保存到本仓库：

```
vfx_factory/public/assets/quarks/CFXR3 Fire Explosion B.json
```

文件名建议保持 Unity 名；也可用 `cfxr_explosion.json`（需同步改 `public/assets/quarks/manifest.json`）。

贴图会以 data URI 内嵌，JSON 自包含。

## 3. 登记到 manifest

编辑 `public/assets/quarks/manifest.json`：

```json
{
  "effects": [
    {
      "id": "cfxr_explosion",
      "label": "CFXR · Fire Explosion (Quarks)",
      "file": "CFXR3 Fire Explosion B.json"
    }
  ]
}
```

## 4. Web 端预览

```bash
npm run quarks
```

浏览器打开 **http://localhost:5173/** → 选效果 → Play（`npm run quarks`）。

## 5. CFXR 保真机制（通用，非单特效）

导出器会在每个 material 上写入 `cfxr` 块：

- `_HdrMultiply` / `_SingleChannel` / `_UseDissolve` / `_DissolveSmooth` / `_Color`
- dissolve 贴图、`proceduralRing`、additive、ring 偏移
- ParticleSystem：`cfxrCustomData.custom1x`（dissolve 时间曲线）、`startDelay`

Web 端 `cfxrQuarksFidelity` **只读这些字段**（按 emitter 名绑定），不再按特效名 hardcode。

若 JSON 是旧导出、没有 `cfxr` 块，可从 Prefab 注入（仍是数据驱动）：

```bash
node scripts/inject_cfxr_materials.mjs \
  "public/assets/quarks/你的效果.json" \
  "unity-ref/.../你的效果.prefab"
```

dissolve 贴图请放到 `public/assets/quarks/`（文件名：贴图名空格改 `_` + `.png`）。

仍未导出：`CFXR_Effect` 点光/震屏（可后续加根节点 `cfxrEffect` 元数据）。

## 6. 批量导出（可选）

Project 窗口选中 `CFXR Prefabs` 文件夹 → **Tools → Quarks → Export Folder of Effects to JSON** → 选输出目录，再把需要的 JSON 拷进 `public/assets/quarks/`。
