/* global Vue, ElementPlus, ElementPlusIconsVue, axios */

const { createApp, ref, reactive, computed, onMounted, h } = Vue;
const { ElMessage, ElMessageBox } = ElementPlus;

// API 基础地址：与后端同源时为空（由 Flask 静态托管），独立运行时可以改成 http://localhost:5050
const API_BASE = (location.port === "5051" || location.protocol === "file:") ? "" : "http://localhost:5051";

const http = axios.create({ baseURL: API_BASE, timeout: 10000 });
http.interceptors.request.use((config) => {
  const token = localStorage.getItem("token");
  if (token) config.headers.Authorization = "Bearer " + token;
  return config;
});
http.interceptors.response.use(
  (resp) => resp,
  (err) => {
    const status = err.response?.status;
    const msg = err.response?.data?.msg || err.message || "请求失败";
    if (status === 401) {
      localStorage.removeItem("token");
      localStorage.removeItem("username");
      ElMessage.error(msg);
      // 触发回到登录
      window.dispatchEvent(new Event("force-logout"));
    } else {
      ElMessage.error(msg);
    }
    return Promise.reject(err);
  }
);

// ---------- 登录组件 ----------
const LoginView = {
  emits: ["login-success"],
  setup(_, { emit }) {
    const form = reactive({ username: "", password: "" });
    const loading = ref(false);
    const submit = async () => {
      if (!form.username || !form.password) {
        ElMessage.warning("请输入账号密码");
        return;
      }
      loading.value = true;
      try {
        const { data } = await http.post("/api/login", form);
        if (data.code === 0) {
          localStorage.setItem("token", data.data.token);
          localStorage.setItem("username", data.data.username);
          ElMessage.success("登录成功");
          emit("login-success", data.data.username);
        }
      } finally {
        loading.value = false;
      }
    };
    return { form, loading, submit };
  },
  template: `
    <div class="login-wrap">
      <div class="login-card">
        <h2 class="login-title">Tag 管理系统</h2>
        <p class="login-sub">请登录以继续</p>
        <el-form :model="form" @submit.prevent="submit" label-position="top">
          <el-form-item label="账号">
            <el-input v-model="form.username" placeholder="请输入账号" clearable />
          </el-form-item>
          <el-form-item label="密码">
            <el-input v-model="form.password" type="password" placeholder="请输入密码" show-password @keyup.enter="submit" />
          </el-form-item>
          <el-button type="primary" style="width:100%" :loading="loading" @click="submit">登录</el-button>
        </el-form>
      </div>
    </div>
  `,
};

// ---------- 主页面 ----------
const HomeView = {
  emits: ["logout"],
  setup(_, { emit }) {
    const username = ref(localStorage.getItem("username") || "");
    const tags = ref([]); // 平铺
    const treeRef = ref(null);
    const filterText = ref("");
    const treeCollapsed = ref(false);
    const genCollapsed = ref(false);
    const tagCloudCollapsed = ref(false);
    const filesCollapsed = ref(false);
    const statsCollapsed = ref(false);

    // 树形结构（包含虚拟"全部标签"根节点，方便全选操作）
    const VIRTUAL_ALL_ID = "__all__";
    const tagTree = computed(() => {
      const realTree = buildTree(tags.value);
      return [{
        id: VIRTUAL_ALL_ID,
        name: "全部标签",
        childCount: tags.value.length,
        children: realTree,
        _virtual: true,
      }];
    });
    // 不含虚拟根节点的树（用于 el-tree-select 下拉选择）
    const tagTreeNoVirtual = computed(() => buildTree(tags.value));

    // ----- 弹窗状态 -----
    const editDialog = reactive({
      visible: false,
      mode: "create", // create | edit
      id: null,
      name: "",
      parentId: null,
      priority: 0,
      title: "新增 Tag",
    });
    const pwdDialog = reactive({
      visible: false,
      oldPassword: "",
      newPassword: "",
      newPassword2: "",
      newUsername: "",
    });

    // 批量导入弹窗
    const importDialog = reactive({
      visible: false,
      text: "",
      parentId: null,
      loading: false,
    });
    const openImport = () => {
      importDialog.text = "";
      importDialog.parentId = null;
      importDialog.visible = true;
    };
    // 解析规则：每行最后一个 "_" 之后的部分，按 "." 拆分；多行结果合并去重
    const parsedTags = computed(() => {
      const text = importDialog.text || "";
      const out = [];
      const seen = new Set();
      text.split(/\r?\n/).forEach((line) => {
        const s = line.trim();
        if (!s) return;
        const idx = s.lastIndexOf("_");
        const seg = idx === -1 ? s : s.slice(idx + 1);
        seg.split(".").forEach((t) => {
          const name = t.trim();
          if (!name) return;
          if (seen.has(name)) return;
          seen.add(name);
          out.push(name);
        });
      });
      return out;
    });
    const submitImport = async () => {
      if (!parsedTags.value.length) {
        ElMessage.warning("没有解析到可导入的标签");
        return;
      }
      importDialog.loading = true;
      try {
        const { data } = await http.post("/api/tags/bulk", {
          names: parsedTags.value,
          parentId: importDialog.parentId || null,
        });
        if (data.code === 0) {
          const { created, skipped } = data.data;
          ElMessage.success(`导入完成：新增 ${created.length} 个，跳过 ${skipped.length} 个`);
          importDialog.visible = false;
          await loadTags();
        }
      } finally {
        importDialog.loading = false;
      }
    };
    const removeParsed = (name) => {
      // 通过在文本里加排除标记不太友好，改为直接从 parsedTags 来源处理：
      // 我们把当前预览结果回写到 text，作为"已编辑"的状态。
      const remain = parsedTags.value.filter((n) => n !== name);
      importDialog.text = remain.join(".");
    };

    // ----- 文件名生成器 -----
    const fileName = ref("");
    // 选中的标签按"选中顺序"维护，元素形如 {id, name}
    const selectedTags = ref([]);
    const dragIndex = ref(-1);

    const todayStr = () => {
      const d = new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}${m}${day}`;
    };
    const finalName = computed(() => {
      const base = (fileName.value || "").trim().toLowerCase();
      const tagPart = selectedTags.value.map((t) => t.name).join(".");
      const date = `[${todayStr()}]`;
      // [日期]文件名_tag1.tag2 ；文件名/标签任一为空时省略对应部分（不留多余下划线）
      let out = date;
      if (base) out += base;
      if (tagPart) out += (base ? "_" : "") + tagPart;
      return out;
    });
    // 树勾选变化：级联选中子级，同步文件列表的标签筛选
    const onTreeCheck = (data, checked) => {
      // 获取实际勾选的 key，排除虚拟"全部标签"节点
      const realChecked = checked.checkedKeys.filter((k) => k !== VIRTUAL_ALL_ID);
      // 仅当文件名不为空时，才将标签填入文件名生成器的已选标签
      if ((fileName.value || "").trim()) {
        // 根据 tags 平铺列表重建 selectedTags（保持已有顺序，追加新增的）
        const checkedSet = new Set(realChecked);
        // 保留已有且仍勾选的
        const kept = selectedTags.value.filter((t) => checkedSet.has(t.id));
        const keptIds = new Set(kept.map((t) => t.id));
        // 追加新勾选的
        const tagMap = new Map(tags.value.map((t) => [t.id, t]));
        realChecked.forEach((id) => {
          if (!keptIds.has(id) && tagMap.has(id)) {
            kept.push({ id, name: tagMap.get(id).name });
          }
        });
        selectedTags.value = kept;
      }
      // 无论文件名是否为空，都同步标签筛选到文件列表并重新查询
      fileQuery.tagIds = realChecked;
      filePagination.page = 1;
      loadFiles();
    };
    const checkedKeys = computed(() => selectedTags.value.map((t) => t.id));
    const removeSelected = (id) => {
      const i = selectedTags.value.findIndex((t) => t.id === id);
      if (i !== -1) selectedTags.value.splice(i, 1);
      treeRef.value?.setChecked(id, false, false);
      // 同步标签筛选
      fileQuery.tagIds = selectedTags.value.map((t) => t.id);
      filePagination.page = 1;
      loadFiles();
    };
    const moveSelected = (idx, delta) => {
      const arr = selectedTags.value;
      const j = idx + delta;
      if (j < 0 || j >= arr.length) return;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
    };
    const clearSelected = () => {
      treeRef.value?.setChecked(VIRTUAL_ALL_ID, false, true);
      selectedTags.value = [];
      // 同步标签筛选
      fileQuery.tagIds = [];
      filePagination.page = 1;
      loadFiles();
    };
    // 文件名生成器中通过搜索选择标签
    const genTagPickIds = computed({
      get: () => selectedTags.value.map((t) => t.id),
      set: () => { /* 由 onGenTagPick 处理 */ },
    });
    const onGenTagPick = (ids) => {
      // 以 ids 为准重建 selectedTags（保持已有顺序，追加新增）
      const tagMap = new Map(tags.value.map((t) => [t.id, t]));
      const kept = selectedTags.value.filter((t) => ids.includes(t.id));
      const keptIds = new Set(kept.map((t) => t.id));
      ids.forEach((id) => {
        if (!keptIds.has(id) && tagMap.has(id)) {
          kept.push({ id, name: tagMap.get(id).name });
        }
      });
      selectedTags.value = kept;
      // 同步左侧树勾选
      treeRef.value?.setChecked(VIRTUAL_ALL_ID, false, true);
      selectedTags.value.forEach((t) => treeRef.value?.setChecked(t.id, true, false));
      // 同步文件列表筛选
      fileQuery.tagIds = selectedTags.value.map((t) => t.id);
      filePagination.page = 1;
      loadFiles();
    };
    // 拖拽排序
    const onDragStart = (idx) => { dragIndex.value = idx; };
    const onDragOver = (e) => { e.preventDefault(); };
    const onDrop = (idx) => {
      const from = dragIndex.value;
      if (from === -1 || from === idx) return;
      const arr = selectedTags.value;
      const [item] = arr.splice(from, 1);
      arr.splice(idx, 0, item);
      dragIndex.value = -1;
    };
    const copyFinal = async () => {
      const text = finalName.value;
      try {
        await navigator.clipboard.writeText(text);
        ElMessage.success("已复制到剪贴板");
      } catch (e) {
        // fallback
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        ElMessage.success("已复制");
      }
    };

    // ----- 保存文件 -----
    const saveLoading = ref(false);
    const saveFinal = async () => {
      // 只保存纯文件名部分（不含日期前缀和标签后缀）
      const pureName = (fileName.value || "").trim().toLowerCase();
      if (!pureName) {
        ElMessage.warning("文件名为空，无法保存");
        return;
      }
      saveLoading.value = true;
      try {
        const { data } = await http.post("/api/files", {
          name: pureName,
          tagIds: selectedTags.value.map((t) => t.id),
        });
        if (data.code === 0) {
          ElMessage.success("已保存");
          await loadFiles();
          loadTagCloud();
        }
      } finally {
        saveLoading.value = false;
      }
    };

    // ----- 文件导入/导出 -----
    const fileImportDialog = reactive({
      visible: false,
      text: "",
      loading: false,
    });
    const openFileImport = () => {
      fileImportDialog.text = "";
      fileImportDialog.loading = false;
      fileImportDialog.visible = true;
    };
    const handleFileImportUpload = (uploadFile) => {
      // uploadFile 可能是 UploadRawFile 或有 raw 属性
      const file = uploadFile.raw || uploadFile;
      const reader = new FileReader();
      reader.onload = (e) => {
        fileImportDialog.text = e.target.result;
      };
      reader.readAsText(file, "utf-8");
      return false;
    };
    const fileImportParsed = computed(() => {
      const text = fileImportDialog.text || "";
      const results = [];
      let currentCategory = null;
      text.split(/\r?\n/).forEach((line) => {
        const s = line.trim();
        if (!s) return;
        // 判断 [xxx] 开头
        const m = s.match(/^\[([^\]]*)\](.*)$/);
        if (m) {
          const bracketContent = m[1];
          let rest = m[2].trim();
          // 8位纯数字视为日期（文件行）
          if (/^\d{8}$/.test(bracketContent)) {
            // 日期后可能还有 [xxx] 方括号标签，逐个解析（去掉[]作为普通标签）
            const extraTags = [];
            let bm;
            while ((bm = rest.match(/^\[([^\]]*)\](.*)$/))) {
              const inner = bm[1].trim();
              rest = bm[2];
              if (inner) extraTags.push(inner);
            }
            // 文件行
            const body = rest;
            const idx = body.lastIndexOf("_");
            let fileName, tagPart;
            if (idx === -1) {
              fileName = body.trim();
              tagPart = "";
            } else {
              fileName = body.slice(0, idx).trim();
              tagPart = body.slice(idx + 1);
            }
            const tagNames = tagPart ? tagPart.split(".").map((t) => t.trim()).filter(Boolean) : [];
            // 把方括号内的标签加入（去重）
            extraTags.forEach((et) => { if (!tagNames.includes(et)) tagNames.push(et); });
            if (currentCategory && !tagNames.includes(currentCategory)) {
              tagNames.push(currentCategory);
            }
            if (fileName) results.push({ fileName, tagNames });
          } else {
            // 分类标签行
            currentCategory = bracketContent.trim() || null;
          }
        } else {
          // 无方括号开头的普通行
          const idx = s.lastIndexOf("_");
          let fileName, tagPart;
          if (idx === -1) {
            fileName = s.trim();
            tagPart = "";
          } else {
            fileName = s.slice(0, idx).trim();
            tagPart = s.slice(idx + 1);
          }
          const tagNames = tagPart ? tagPart.split(".").map((t) => t.trim()).filter(Boolean) : [];
          if (currentCategory && !tagNames.includes(currentCategory)) {
            tagNames.push(currentCategory);
          }
          if (fileName) results.push({ fileName, tagNames });
        }
      });
      return results;
    });
    const importProgress = reactive({ visible: false, total: 0, created: 0, status: "" });
    const submitFileImport = async () => {
      if (!fileImportParsed.value.length) {
        ElMessage.warning("没有解析到可导入的文件");
        return;
      }
      fileImportDialog.loading = true;
      try {
        const { data } = await http.post("/api/files/import", {
          text: fileImportDialog.text,
        });
        if (data.code === 0) {
          const taskId = data.data.taskId;
          fileImportDialog.visible = false;
          fileImportDialog.loading = false;
          // 显示进度提示
          importProgress.visible = true;
          importProgress.total = fileImportParsed.value.length;
          importProgress.created = 0;
          importProgress.status = "running";
          // 轮询进度
          const poll = setInterval(async () => {
            try {
              const { data: st } = await http.get("/api/files/import/status", { params: { taskId } });
              if (st.code === 0) {
                importProgress.created = st.data.created;
                importProgress.status = st.data.status;
                if (st.data.status === "done") {
                  clearInterval(poll);
                  importProgress.visible = false;
                  ElMessage.success(st.data.msg || "导入完成");
                  await loadFiles();
                  loadTagCloud();
                } else if (st.data.status === "error") {
                  clearInterval(poll);
                  importProgress.visible = false;
                  ElMessage.error(st.data.msg || "导入失败");
                }
              }
            } catch (e) {
              clearInterval(poll);
              importProgress.visible = false;
              ElMessage.error("查询导入进度失败");
            }
          }, 1000);
        } else {
          ElMessage.error(data.msg || "导入失败");
        }
      } catch (e) {
        // 请求本身失败
      } finally {
        fileImportDialog.loading = false;
      }
    };
    // ----- 导出对话框 -----
    const exportDialog = reactive({
      visible: false,
      tagIds: [],
      sort: "name",  // name | date
      group: true,
    });
    const openExportDialog = () => {
      exportDialog.visible = true;
    };
    const exportFiles = async () => {
      try {
        const token = localStorage.getItem("token");
        const params = new URLSearchParams();
        if (exportDialog.tagIds.length) {
          params.set("tag_ids", exportDialog.tagIds.join(","));
        }
        params.set("sort", exportDialog.sort);
        params.set("group", exportDialog.group ? "1" : "0");
        const resp = await fetch("/api/files/export?" + params.toString(), {
          headers: { Authorization: "Bearer " + token },
        });
        if (!resp.ok) {
          ElMessage.error("导出失败");
          return;
        }
        const blob = await resp.blob();
        const url = URL.createObjectURL(blob);
        const now = new Date();
        const ts = now.getFullYear().toString()
          + String(now.getMonth() + 1).padStart(2, '0')
          + String(now.getDate()).padStart(2, '0')
          + String(now.getHours()).padStart(2, '0')
          + String(now.getMinutes()).padStart(2, '0');
        const a = document.createElement("a");
        a.href = url;
        a.download = `tag_${ts}.txt`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        ElMessage.success("导出成功");
        exportDialog.visible = false;
      } catch (e) {
        ElMessage.error("导出失败");
      }
    };

    // ----- 标签云 -----
    const tagCloudData = ref([]);
    const tagCloudLoading = ref(false);
    // 缩放/平移状态
    const tagCloudContainerRef = ref(null);
    const tagCloudView = reactive({ scale: 1, tx: 0, ty: 0 });
    const tagCloudCanvasStyle = computed(() => ({
      transform: `translate(${tagCloudView.tx}px, ${tagCloudView.ty}px) scale(${tagCloudView.scale})`,
      transformOrigin: '0 0',
      width: '100%',
      height: '100%',
      position: 'relative',
    }));
    const onTagCloudWheel = (e) => {
      // preventDefault 由模板 @wheel.prevent 处理
      const container = e.currentTarget;
      const rect = container.getBoundingClientRect();
      // 鼠标在容器中的坐标
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // 缩放因子
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      const newScale = Math.max(0.4, Math.min(5, tagCloudView.scale * factor));
      const realFactor = newScale / tagCloudView.scale;
      // 以鼠标位置为缩放中心：使鼠标下的画布点保持不动
      tagCloudView.tx = mx - (mx - tagCloudView.tx) * realFactor;
      tagCloudView.ty = my - (my - tagCloudView.ty) * realFactor;
      tagCloudView.scale = newScale;
    };
    // 单个标签拖拽偏移量 { [tagId]: { dx, dy } }
    const tagItemOffsets = reactive({});
    let _dragState = null;
    const onTagCloudMouseDown = (e) => {
      // 仅响应鼠标左键
      if (e.button !== 0) return;
      _dragState = {
        type: 'canvas', // 默认拖拽画布
        startX: e.clientX,
        startY: e.clientY,
        origTx: tagCloudView.tx,
        origTy: tagCloudView.ty,
        moved: false,
      };
    };
    const onTagItemMouseDown = (t, e) => {
      // 单个标签的拖拽
      if (e.button !== 0) return;
      e.stopPropagation(); // 阻止冒泡到画布拖拽
      const offset = tagItemOffsets[t.id] || { dx: 0, dy: 0 };
      _dragState = {
        type: 'item',
        tagId: t.id,
        startX: e.clientX,
        startY: e.clientY,
        origDx: offset.dx,
        origDy: offset.dy,
        moved: false,
      };
    };
    const onTagCloudMouseMove = (e) => {
      if (!_dragState) return;
      const dx = e.clientX - _dragState.startX;
      const dy = e.clientY - _dragState.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) _dragState.moved = true;
      if (_dragState.type === 'canvas') {
        tagCloudView.tx = _dragState.origTx + dx;
        tagCloudView.ty = _dragState.origTy + dy;
      } else if (_dragState.type === 'item') {
        // 单个标签拖动：需要除以缩放比例，使拖动距离与视觉一致
        const scale = tagCloudView.scale || 1;
        tagItemOffsets[_dragState.tagId] = {
          dx: _dragState.origDx + dx / scale,
          dy: _dragState.origDy + dy / scale,
        };
      }
    };
    const onTagCloudMouseUp = () => { _dragState = null; };
    const onTagCloudItemClick = (t, e) => {
      // 拖拽过程中触发的 click 不视为筛选
      if (_dragState && _dragState.moved) return;
      filterByTag(t);
    };
    const centerTagCloud = () => {
      // 将 500x300 画布中心对齐到容器中心
      const el = tagCloudContainerRef.value;
      if (!el) {
        tagCloudView.tx = 0;
        tagCloudView.ty = 0;
        return;
      }
      const cw = el.clientWidth;
      const ch = el.clientHeight;
      // 画布内容区域固定为 500x300
      tagCloudView.tx = (cw - 500) / 2;
      tagCloudView.ty = (ch - 300) / 2;
    };
    const resetTagCloudView = () => {
      tagCloudView.scale = 1;
      Object.keys(tagItemOffsets).forEach(k => delete tagItemOffsets[k]);
      centerTagCloud();
    };
    const loadTagCloud = async () => {
      tagCloudLoading.value = true;
      try {
        const { data } = await http.get("/api/tags/stats");
        if (data.code === 0) {
          tagCloudData.value = data.data.filter((t) => t.count > 1);
          // 数据加载后下一帧居中
          Vue.nextTick(() => centerTagCloud());
        }
      } finally {
        tagCloudLoading.value = false;
      }
    };
    // 计算标签云位置（云朵形状分布，保证不重叠，标签过多时自动缩小）
    const tagCloudPositions = computed(() => {
      const data = tagCloudData.value;
      if (!data.length) return [];
      const counts = data.map((t) => t.count);
      const max = Math.max(...counts);
      const min = Math.min(...counts);
      const baseMinSize = 13;
      const baseMaxSize = 34;

      // 使用固定种子的伪随机，让每次渲染结果一致
      const seededRandom = (seed) => {
        const x = Math.sin(seed * 9301 + 49297) * 233280;
        return x - Math.floor(x);
      };

      // 云朵形状：多个椭圆组合
      const isInCloud = (nx, ny) => {
        // 主体椭圆
        const main = (nx * nx) / (1.0 * 1.0) + (ny * ny) / (0.7 * 0.7);
        if (main <= 1) return true;
        // 左上凸起
        const lx = nx + 0.5, ly = ny + 0.35;
        if ((lx * lx) / (0.45 * 0.45) + (ly * ly) / (0.4 * 0.4) <= 1) return true;
        // 右上凸起
        const rx = nx - 0.4, ry = ny + 0.4;
        if ((rx * rx) / (0.5 * 0.5) + (ry * ry) / (0.4 * 0.4) <= 1) return true;
        // 顶部凸起
        const tx = nx + 0.05, ty = ny + 0.55;
        if ((tx * tx) / (0.4 * 0.4) + (ty * ty) / (0.35 * 0.35) <= 1) return true;
        return false;
      };

      // 碰撞检测辅助函数
      const hasOverlap = (px, py, w, h, placed, gap) => {
        for (const p of placed) {
          if (px < p.x + p.w + gap && px + w + gap > p.x &&
              py < p.y + p.h + gap && py + h + gap > p.y) {
            return true;
          }
        }
        return false;
      };

      // 尝试以指定缩放比例布局所有标签，返回 null 表示布局失败
      const tryLayout = (scaleFactor) => {
        const minSize = baseMinSize * scaleFactor;
        const maxSize = baseMaxSize * scaleFactor;
        const positions = [];
        const placed = []; // 已放置的标签 {x, y, w, h}
        const gap = Math.max(2, 4 * scaleFactor); // 标签间隙随比例缩小

        for (let i = 0; i < data.length; i++) {
          const tag = data[i];
          let size;
          if (max === min) {
            size = 18 * scaleFactor;
          } else {
            size = minSize + ((tag.count - min) / (max - min)) * (maxSize - minSize);
          }
          size = Math.round(size);

          // 估算标签宽高（字符数 * 字号）
          const estW = tag.name.length * size * 0.7 + 16 * scaleFactor;
          const estH = size * 1.5 + 8 * scaleFactor;

          // 在云朵区域内螺旋搜索放置位置，扩大搜索范围
          let bestX = 0, bestY = 0, found = false;
          const maxAttempts = 400;
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            // 螺旋 + 随机
            const angle = attempt * 0.618 * Math.PI * 2;
            const radius = 0.03 + attempt * 0.004;
            const jitterX = (seededRandom(i * 1000 + attempt * 7) - 0.5) * 0.12;
            const jitterY = (seededRandom(i * 2000 + attempt * 13) - 0.5) * 0.1;
            const nx = Math.cos(angle) * radius + jitterX;
            const ny = Math.sin(angle) * radius + jitterY;

            if (!isInCloud(nx, ny)) continue;

            // 转换为像素坐标 (容器 500x300)
            const px = 250 + nx * 220 - estW / 2;
            const py = 150 + ny * 130 - estH / 2;

            // 确保在画布范围内
            if (px < 0 || px + estW > 500 || py < 0 || py + estH > 300) continue;

            // 检查是否与已放置标签重叠
            if (!hasOverlap(px, py, estW, estH, placed, gap)) {
              bestX = px;
              bestY = py;
              found = true;
              break;
            }
          }

          if (!found) {
            // 当前比例放不下，返回 null 触发缩小
            return null;
          }

          placed.push({ x: bestX, y: bestY, w: estW, h: estH });

          // 颜色策略：基于标签 id（或索引）使用黄金角分布生成色相
          const hue = ((tag.id || (i + 1)) * 137.508) % 360;
          const ratio = max === min ? 0.5 : (tag.count - min) / (max - min);
          const saturation = Math.round(55 + ratio * 30);
          const lightness = Math.round(55 - ratio * 22);
          const color = `hsl(${hue}, ${saturation}%, ${lightness}%)`;

          // 加入手动拖拽偏移
          const offset = tagItemOffsets[tag.id] || { dx: 0, dy: 0 };
          positions.push({
            ...tag,
            style: {
              position: 'absolute',
              left: (bestX + offset.dx) + 'px',
              top: (bestY + offset.dy) + 'px',
              fontSize: size + 'px',
              color: color,
              cursor: 'grab',
              padding: (3 * scaleFactor) + 'px ' + (6 * scaleFactor) + 'px',
              lineHeight: '1.4',
              whiteSpace: 'nowrap',
              fontWeight: ratio > 0.6 ? '700' : (ratio > 0.3 ? '600' : '500'),
              borderRadius: '4px',
              transition: 'background 0.2s ease, text-shadow 0.2s ease',
              userSelect: 'none',
            },
          });
        }
        return positions;
      };

      // 逐步缩小比例直到所有标签都能不重叠放置
      let scale = 1.0;
      const minScale = 0.4; // 最小缩放到 40%
      const scaleStep = 0.1;
      let result = null;
      while (scale >= minScale) {
        result = tryLayout(scale);
        if (result) break;
        scale -= scaleStep;
      }

      // 如果即使最小比例也放不下（极端情况），用最小比例强制布局，允许溢出但不重叠
      if (!result) {
        // 最后兜底：用最小比例，放不下的就不显示
        const finalScale = minScale;
        const minSize = baseMinSize * finalScale;
        const maxSize = baseMaxSize * finalScale;
        const positions = [];
        const placed = [];
        const gap = 2;
        for (let i = 0; i < data.length; i++) {
          const tag = data[i];
          let size = max === min ? 18 * finalScale : minSize + ((tag.count - min) / (max - min)) * (maxSize - minSize);
          size = Math.round(size);
          const estW = tag.name.length * size * 0.7 + 16 * finalScale;
          const estH = size * 1.5 + 8 * finalScale;

          let bestX = 0, bestY = 0, found = false;
          for (let attempt = 0; attempt < 600; attempt++) {
            const angle = attempt * 0.618 * Math.PI * 2;
            const radius = 0.03 + attempt * 0.003;
            const jitterX = (seededRandom(i * 1000 + attempt * 7) - 0.5) * 0.1;
            const jitterY = (seededRandom(i * 2000 + attempt * 13) - 0.5) * 0.08;
            const nx = Math.cos(angle) * radius + jitterX;
            const ny = Math.sin(angle) * radius + jitterY;
            if (!isInCloud(nx, ny)) continue;
            const px = 250 + nx * 220 - estW / 2;
            const py = 150 + ny * 130 - estH / 2;
            if (!hasOverlap(px, py, estW, estH, placed, gap)) {
              bestX = px; bestY = py; found = true; break;
            }
          }
          if (!found) continue; // 实在放不下则跳过不显示

          placed.push({ x: bestX, y: bestY, w: estW, h: estH });
          const hue = ((tag.id || (i + 1)) * 137.508) % 360;
          const ratio = max === min ? 0.5 : (tag.count - min) / (max - min);
          const saturation = Math.round(55 + ratio * 30);
          const lightness = Math.round(55 - ratio * 22);
          const color = `hsl(${hue}, ${saturation}%, ${lightness}%)`;
          const offset = tagItemOffsets[tag.id] || { dx: 0, dy: 0 };
          positions.push({
            ...tag,
            style: {
              position: 'absolute',
              left: (bestX + offset.dx) + 'px',
              top: (bestY + offset.dy) + 'px',
              fontSize: size + 'px',
              color: color,
              cursor: 'grab',
              padding: (3 * finalScale) + 'px ' + (6 * finalScale) + 'px',
              lineHeight: '1.4',
              whiteSpace: 'nowrap',
              fontWeight: ratio > 0.6 ? '700' : (ratio > 0.3 ? '600' : '500'),
              borderRadius: '4px',
              transition: 'background 0.2s ease, text-shadow 0.2s ease',
              userSelect: 'none',
            },
          });
        }
        result = positions;
      }

      return result;
    });

    // ----- 统计列表 -----
    const statsData = ref([]);
    const statsTotal = ref(0);
    const statsLoading = ref(false);
    const statsQuery = reactive({
      groupBy: "tag", // tag | date
      dateRange: null,
      tagIds: [],
    });
    const loadStats = async () => {
      statsLoading.value = true;
      try {
        const params = { groupBy: statsQuery.groupBy };
        if (statsQuery.dateRange && statsQuery.dateRange.length === 2) {
          const fmt = (d) => (typeof d === "string" ? d : (() => { const dt = new Date(d); return dt.getFullYear() + "-" + String(dt.getMonth()+1).padStart(2,"0") + "-" + String(dt.getDate()).padStart(2,"0"); })());
          params.dateFrom = fmt(statsQuery.dateRange[0]);
          params.dateTo = fmt(statsQuery.dateRange[1]);
        }
        if (statsQuery.tagIds.length) {
          params.tagIds = statsQuery.tagIds.join(",");
        }
        const { data } = await http.get("/api/files/stats", { params });
        if (data.code === 0) {
          statsData.value = data.data;
          statsTotal.value = data.total || 0;
        }
      } finally {
        statsLoading.value = false;
      }
    };
    const resetStats = () => {
      statsQuery.groupBy = "tag";
      statsQuery.dateRange = null;
      statsQuery.tagIds = [];
      loadStats();
    };

    // ----- 文件列表 -----
    const fileList = ref([]);
    const fileQuery = reactive({
      keyword: "",
      tagIds: [],
      mode: "all", // all | any
      dateRange: null, // [startDate, endDate]
    });
    const fileLoading = ref(false);
    const filePagination = reactive({
      page: 1,
      pageSize: 20,
      total: 0,
    });
    const loadFiles = async () => {
      fileLoading.value = true;
      try {
        const params = {
          page: filePagination.page,
          pageSize: filePagination.pageSize,
        };
        if (fileQuery.keyword) params.keyword = fileQuery.keyword;
        if (fileQuery.tagIds.length) {
          params.tagIds = fileQuery.tagIds.join(",");
          params.mode = fileQuery.mode;
        }
        if (fileQuery.dateRange && fileQuery.dateRange.length === 2) {
          // value-format="YYYY-MM-DD" 时返回字符串，否则返回 Date 对象
          const fmt = (d) => {
            if (typeof d === "string") return d;
            const dt = new Date(d);
            return dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") + "-" + String(dt.getDate()).padStart(2, "0");
          };
          params.dateFrom = fmt(fileQuery.dateRange[0]);
          params.dateTo = fmt(fileQuery.dateRange[1]);
        }
        const { data } = await http.get("/api/files", { params });
        if (data.code === 0) {
          fileList.value = data.data;
          filePagination.total = data.total || 0;
        }
      } finally {
        fileLoading.value = false;
      }
    };
    const onPageChange = (page) => {
      filePagination.page = page;
      loadFiles();
    };
    const onPageSizeChange = (size) => {
      filePagination.pageSize = size;
      filePagination.page = 1;
      loadFiles();
    };
    const resetFileQuery = () => {
      fileQuery.keyword = "";
      fileQuery.tagIds = [];
      fileQuery.mode = "all";
      fileQuery.dateRange = null;
      filePagination.page = 1;
      // 同步清空左侧树的勾选
      treeRef.value?.setChecked(VIRTUAL_ALL_ID, false, true);
      selectedTags.value = [];
      loadFiles();
    };
    // 文件列表标签下拉变化时同步左侧树勾选并刷新
    const onFileQueryTagChange = (ids) => {
      // 先清空左侧树勾选
      treeRef.value?.setChecked(VIRTUAL_ALL_ID, false, true);
      // 逐个勾选
      ids.forEach((id) => treeRef.value?.setChecked(id, true, false));
      selectedTags.value = ids.map((id) => {
        const t = tags.value.find((x) => x.id === id);
        return { id, name: t ? t.name : String(id) };
      });
      filePagination.page = 1;
      loadFiles();
    };
    const filterByTag = (tag) => {
      // 清空之前的勾选，然后只勾选该标签
      treeRef.value?.setChecked(VIRTUAL_ALL_ID, false, true);
      selectedTags.value = [{ id: tag.id, name: tag.name }];
      treeRef.value?.setChecked(tag.id, true, false);
      fileQuery.tagIds = [tag.id];
      fileQuery.mode = "all";
      filePagination.page = 1;
      loadFiles();
    };
    // 移除单个文件的某个标签
    const removeFileTag = async (file, tag) => {
      try {
        const { data } = await http.post("/api/files/batch-remove-tags", {
          fileIds: [file.id],
          tagIds: [tag.id],
        });
        if (data.code === 0) {
          // 从本地 row 中移除该标签，避免重新请求整个列表
          const idx = file.tags.findIndex((t) => t.id === tag.id);
          if (idx !== -1) file.tags.splice(idx, 1);
          ElMessage.success(`已移除标签「${tag.name}」`);
        }
      } catch (e) { /* http拦截器已处理 */ }
    };
    // 行内添加标签
    const inlineAddTagState = reactive({ fileId: null, tagIds: [] });
    const showInlineAddTag = (file) => {
      inlineAddTagState.fileId = file.id;
      inlineAddTagState.tagIds = [];
    };
    const hideInlineAddTag = () => {
      inlineAddTagState.fileId = null;
      inlineAddTagState.tagIds = [];
    };
    const submitInlineAddTag = async (file) => {
      if (!inlineAddTagState.tagIds.length) { hideInlineAddTag(); return; }
      // 区分已有标签 ID（数字）和新建标签名（字符串）
      const existingIds = [];
      const newNames = [];
      inlineAddTagState.tagIds.forEach((v) => {
        if (typeof v === "number") {
          existingIds.push(v);
        } else {
          // allow-create 产生的是字符串
          newNames.push(String(v).trim());
        }
      });
      try {
        // 1. 先创建新标签
        const createdIds = [];
        for (const name of newNames) {
          if (!name) continue;
          const { data } = await http.post("/api/tags", { name });
          if (data.code === 0 && data.data && data.data.id) {
            createdIds.push(data.data.id);
          }
        }
        // 合并所有需要添加的标签ID
        const allTagIds = [...existingIds, ...createdIds];
        if (!allTagIds.length) { hideInlineAddTag(); return; }
        // 2. 为文件添加标签
        const { data } = await http.post("/api/files/batch-add-tags", {
          fileIds: [file.id],
          tagIds: allTagIds,
        });
        if (data.code === 0) {
          // 如果有新建标签，刷新标签列表
          if (createdIds.length) await loadTags();
          // 将标签追加到本地 row
          const tagMap = new Map(tags.value.map((t) => [t.id, t]));
          const fileExistingIds = new Set(file.tags.map((t) => t.id));
          allTagIds.forEach((id) => {
            if (!fileExistingIds.has(id) && tagMap.has(id)) {
              file.tags.push({ id, name: tagMap.get(id).name });
            }
          });
          ElMessage.success("标签添加成功");
        }
      } catch (e) { /* http拦截器已处理 */ }
      hideInlineAddTag();
    };
    const selectedFiles = ref([]);
    const onSelectionChange = (rows) => {
      selectedFiles.value = rows;
    };
    // ----- 批量添加/移除标签 -----
    const batchTagDialog = reactive({
      visible: false,
      mode: "add", // add | remove
      tagIds: [],
      loading: false,
    });
    const openBatchAddTag = () => {
      if (!selectedFiles.value.length) { ElMessage.warning("请先选择文件"); return; }
      batchTagDialog.mode = "add";
      batchTagDialog.tagIds = [];
      batchTagDialog.visible = true;
    };
    const openBatchRemoveTag = () => {
      if (!selectedFiles.value.length) { ElMessage.warning("请先选择文件"); return; }
      batchTagDialog.mode = "remove";
      batchTagDialog.tagIds = [];
      batchTagDialog.visible = true;
    };
    const submitBatchTag = async () => {
      if (!batchTagDialog.tagIds.length) { ElMessage.warning("请选择标签"); return; }
      batchTagDialog.loading = true;
      try {
        const fileIds = selectedFiles.value.map((f) => f.id);
        const url = batchTagDialog.mode === "add" ? "/api/files/batch-add-tags" : "/api/files/batch-remove-tags";
        const { data } = await http.post(url, { fileIds, tagIds: batchTagDialog.tagIds });
        if (data.code === 0) {
          ElMessage.success(data.msg);
          batchTagDialog.visible = false;
          await loadFiles();
          loadTagCloud();
        }
      } finally {
        batchTagDialog.loading = false;
      }
    };

    // ----- 行内重命名 -----
    const inlineRenameId = ref(null);
    const inlineRenameName = ref("");
    const startInlineRename = (file) => {
      inlineRenameId.value = file.id;
      inlineRenameName.value = file.name;
    };
    const cancelInlineRename = () => {
      inlineRenameId.value = null;
      inlineRenameName.value = "";
    };
    const submitInlineRename = async (file) => {
      const name = (inlineRenameName.value || "").trim();
      if (!name) {
        ElMessage.warning("文件名不能为空");
        return;
      }
      if (name === file.name) {
        cancelInlineRename();
        return;
      }
      try {
        const { data } = await http.post(`/api/files/${file.id}/rename`, { name });
        if (data.code === 0) {
          ElMessage.success("重命名成功");
          cancelInlineRename();
          await loadFiles();
        }
      } catch (e) { /* interceptor handles */ }
    };

    // ----- 批量文件名替换 -----
    const batchRenameDialog = reactive({
      visible: false,
      search: "",
      replace: "",
      useRegex: false,
      regexError: "",
      loading: false,
    });
    const openBatchRename = () => {
      if (!selectedFiles.value.length) { ElMessage.warning("请先选择文件"); return; }
      batchRenameDialog.search = "";
      batchRenameDialog.replace = "";
      batchRenameDialog.useRegex = false;
      batchRenameDialog.regexError = "";
      batchRenameDialog.visible = true;
    };
    const batchRenamePreview = computed(() => {
      if (!batchRenameDialog.search) return [];
      batchRenameDialog.regexError = "";
      if (batchRenameDialog.useRegex) {
        // 正则模式
        let regex;
        try {
          regex = new RegExp(batchRenameDialog.search, "g");
        } catch (e) {
          batchRenameDialog.regexError = "正则表达式语法错误：" + e.message;
          return [];
        }
        return selectedFiles.value
          .map((f) => {
            const re = new RegExp(batchRenameDialog.search, "g");
            const newName = f.name.replace(re, batchRenameDialog.replace);
            return { id: f.id, oldName: f.name, newName };
          })
          .filter((item) => item.newName !== item.oldName);
      } else {
        // 普通字符串模式
        return selectedFiles.value
          .filter((f) => f.name.includes(batchRenameDialog.search))
          .map((f) => ({
            id: f.id,
            oldName: f.name,
            newName: f.name.replaceAll(batchRenameDialog.search, batchRenameDialog.replace),
          }));
      }
    });
    const submitBatchRename = async () => {
      if (!batchRenameDialog.search) { ElMessage.warning("查找内容不能为空"); return; }
      if (batchRenameDialog.regexError) { ElMessage.warning("正则表达式有语法错误，请修正"); return; }
      if (!batchRenamePreview.value.length) { ElMessage.warning("没有匹配到需要替换的文件"); return; }
      batchRenameDialog.loading = true;
      try {
        const fileIds = selectedFiles.value.map((f) => f.id);
        const { data } = await http.post("/api/files/batch-rename", {
          fileIds,
          search: batchRenameDialog.search,
          replace: batchRenameDialog.replace,
          useRegex: batchRenameDialog.useRegex,
        });
        if (data.code === 0) {
          ElMessage.success(data.msg);
          batchRenameDialog.visible = false;
          await loadFiles();
        }
      } finally {
        batchRenameDialog.loading = false;
      }
    };

    const batchDeleteFiles = async () => {
      if (!selectedFiles.value.length) {
        ElMessage.warning("请先选择要删除的文件");
        return;
      }
      try {
        await ElMessageBox.confirm(
          `确定删除选中的 ${selectedFiles.value.length} 个文件？`,
          "批量删除",
          { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
        );
      } catch (_) { return; }
      const ids = selectedFiles.value.map((f) => f.id);
      const { data } = await http.post("/api/files/batch-delete", { ids });
      if (data.code === 0) {
        ElMessage.success(data.msg || "已删除");
        await loadFiles();
        loadTagCloud();
      }
    };
    const removeFile = async (file) => {
      try {
        await ElMessageBox.confirm(
          `确定删除文件 "${file.name}"？`,
          "确认删除",
          { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
        );
      } catch (_) { return; }
      const { data } = await http.delete(`/api/files/${file.id}`);
      if (data.code === 0) {
        ElMessage.success("已删除");
        await loadFiles();
        loadTagCloud();
      }
    };
    const buildFullName = (file) => {
      const date = file.createdAt ? file.createdAt.slice(0, 10).replace(/-/g, "") : todayStr();
      const tagPart = file.tags.map((t) => t.name).join(".");
      let out = `[${date}]`;
      if (file.name && tagPart) out += `${file.name}_${tagPart}`;
      else if (file.name) out += file.name;
      else if (tagPart) out += tagPart;
      return out;
    };
    const copyFileName = async (file) => {
      const text = buildFullName(file);
      try {
        await navigator.clipboard.writeText(text);
        ElMessage.success("已复制：" + text);
      } catch (e) {
        const ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        ElMessage.success("已复制");
      }
    };
    // ----- 编辑文件弹窗 -----
    const fileEditDialog = reactive({
      visible: false,
      id: null,
      name: "",
      tagIds: [],
      loading: false,
    });
    const openFileEdit = (file) => {
      fileEditDialog.id = file.id;
      fileEditDialog.name = file.name;
      fileEditDialog.tagIds = file.tags.map((t) => t.id);
      fileEditDialog.loading = false;
      fileEditDialog.visible = true;
    };
    const submitFileEdit = async () => {
      const name = (fileEditDialog.name || "").trim();
      if (!name) {
        ElMessage.warning("文件名不能为空");
        return;
      }
      fileEditDialog.loading = true;
      try {
        const { data } = await http.put(`/api/files/${fileEditDialog.id}`, {
          name,
          tagIds: fileEditDialog.tagIds,
        });
        if (data.code === 0) {
          ElMessage.success("更新成功");
          fileEditDialog.visible = false;
          await loadFiles();
          loadTagCloud();
        } else {
          ElMessage.error(data.msg || "更新失败");
        }
      } finally {
        fileEditDialog.loading = false;
      }
    };

    // ----- 数据加载 -----
    const loadTags = async () => {
      const { data } = await http.get("/api/tags");
      if (data.code === 0) {
        tags.value = data.data;
        // 清理已不存在的选中项（例如别处删除后）
        const validIds = new Set(data.data.map((t) => t.id));
        selectedTags.value = selectedTags.value.filter((t) => validIds.has(t.id));
      }
    };

    // ----- 操作 -----
    const openCreate = (parentId = null) => {
      editDialog.mode = "create";
      editDialog.id = null;
      editDialog.name = "";
      editDialog.parentId = parentId;
      editDialog.priority = 0;
      editDialog.title = parentId ? "新增子 Tag" : "新增 Tag";
      editDialog.visible = true;
    };

    const openEdit = (node) => {
      editDialog.mode = "edit";
      editDialog.id = node.id;
      editDialog.name = node.name;
      editDialog.parentId = node.parentId;
      editDialog.priority = node.priority || 0;
      editDialog.title = "编辑 Tag";
      editDialog.visible = true;
    };

    const submitEdit = async () => {
      const name = (editDialog.name || "").trim();
      if (!name) {
        ElMessage.warning("名称不能为空");
        return;
      }
      const payload = { name, parentId: editDialog.parentId || null, priority: editDialog.priority || 0 };
      if (editDialog.mode === "create") {
        const { data } = await http.post("/api/tags", payload);
        if (data.code === 0) {
          ElMessage.success("已新增");
          editDialog.visible = false;
          await loadTags();
        }
      } else {
        const { data } = await http.put(`/api/tags/${editDialog.id}`, payload);
        if (data.code === 0) {
          ElMessage.success("已更新");
          editDialog.visible = false;
          await loadTags();
        }
      }
    };

    const removeTag = async (node) => {
      // 前端预检查：有子标签则提示
      if (node.children && node.children.length > 0) {
        ElMessage.warning("该标签下还有子标签，无法删除");
        return;
      }
      try {
        await ElMessageBox.confirm(
          `确定删除 "${node.name}"？`,
          "确认删除",
          { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
        );
      } catch (_) { return; }
      const { data } = await http.delete(`/api/tags/${node.id}`);
      if (data.code === 0) {
        ElMessage.success("已删除");
        // 从已选标签中移除
        selectedTags.value = selectedTags.value.filter((t) => t.id !== node.id);
        // 同步文件列表筛选条件
        fileQuery.tagIds = selectedTags.value.map((t) => t.id);
        await loadTags();
        loadFiles();
      }
    };

    // ----- 批量移动标签 -----
    const batchMoveDialog = reactive({
      visible: false,
      targetParentId: null,
      loading: false,
    });
    const openBatchMove = () => {
      // 获取左侧树中勾选的标签（用于文件名生成器的那些勾选）
      const checkedNodes = treeRef.value?.getCheckedKeys() || [];
      if (!checkedNodes.length) {
        ElMessage.warning("请先在左侧标签树中勾选要移动的标签");
        return;
      }
      batchMoveDialog.targetParentId = null;
      batchMoveDialog.visible = true;
    };
    // 批量移动可选的目标父级（排除已勾选的标签）
    const batchMoveParentOptions = computed(() => {
      const checked = new Set(treeRef.value?.getCheckedKeys() || []);
      const all = buildTree(tags.value);
      const prune = (nodes) => {
        const result = [];
        for (const node of nodes) {
          if (checked.has(node.id)) continue;
          const copy = { ...node };
          if (copy.children) copy.children = prune(copy.children);
          result.push(copy);
        }
        return result;
      };
      return prune(all);
    });
    const submitBatchMove = async () => {
      const ids = treeRef.value?.getCheckedKeys() || [];
      if (!ids.length) {
        ElMessage.warning("没有选中的标签");
        return;
      }
      batchMoveDialog.loading = true;
      try {
        const { data } = await http.post("/api/tags/batch-move", {
          ids,
          targetParentId: batchMoveDialog.targetParentId || null,
        });
        if (data.code === 0) {
          ElMessage.success(data.msg || "移动成功");
          batchMoveDialog.visible = false;
          // 清空选中状态
          selectedTags.value = [];
          await loadTags();
        }
      } finally {
        batchMoveDialog.loading = false;
      }
    };

    // ----- 拖拽改变标签层级 -----
    const allowTreeDrag = (node) => {
      // 虚拟根节点不允许拖动
      return !node.data._virtual;
    };
    const allowTreeDrop = (draggingNode, dropNode, type) => {
      // 不允许拖到虚拟根节点的前面/后面（只能放到里面作为顶级）
      if (dropNode.data._virtual) {
        return type === "inner";
      }
      return true;
    };
    const onTreeNodeDrop = async (draggingNode, dropNode, dropType) => {
      // 计算新的 parentId
      let newParentId = null;
      if (dropType === "inner") {
        // 放入目标节点内部，目标节点成为父级
        newParentId = dropNode.data._virtual ? null : dropNode.data.id;
      } else {
        // before / after: 与目标节点同级，取目标节点的父级
        if (dropNode.parent && dropNode.parent.data && !dropNode.parent.data._virtual) {
          newParentId = dropNode.parent.data.id;
        } else {
          newParentId = null; // 顶级
        }
      }
      // 如果拖拽的节点在已勾选的标签中，则同时移动所有已勾选的标签
      const checkedIds = (treeRef.value?.getCheckedKeys() || []).filter((k) => k !== VIRTUAL_ALL_ID);
      const dragId = draggingNode.data.id;
      let moveIds;
      if (checkedIds.length > 1 && checkedIds.includes(dragId)) {
        // 排除目标父级自身（不能移动到自己内部）
        moveIds = checkedIds.filter((id) => id !== newParentId);
      } else {
        moveIds = [dragId];
      }
      try {
        const { data } = await http.post("/api/tags/batch-move", {
          ids: moveIds,
          targetParentId: newParentId,
        });
        if (data.code === 0) {
          await loadTags();
          if (moveIds.length > 1) {
            ElMessage.success(`已移动 ${moveIds.length} 个标签`);
          }
        } else {
          ElMessage.error(data.msg || "移动失败");
          await loadTags(); // 回滚UI
        }
      } catch (e) {
        await loadTags(); // 回滚UI
      }
    };

    // 用于父级选择器：编辑时需要排除自己以及自己的后代
    const parentOptions = computed(() => {
      const all = buildTree(tags.value);
      if (editDialog.mode === "edit" && editDialog.id) {
        return pruneSelf(all, editDialog.id);
      }
      return all;
    });

    // ----- 修改密码 -----
    const openPwd = () => {
      pwdDialog.oldPassword = "";
      pwdDialog.newPassword = "";
      pwdDialog.newPassword2 = "";
      pwdDialog.newUsername = username.value;
      pwdDialog.visible = true;
    };
    const submitPwd = async () => {
      if (!pwdDialog.oldPassword || !pwdDialog.newPassword) {
        ElMessage.warning("请填写完整");
        return;
      }
      if (pwdDialog.newPassword.length < 4) {
        ElMessage.warning("新密码长度至少 4 位");
        return;
      }
      if (pwdDialog.newPassword !== pwdDialog.newPassword2) {
        ElMessage.warning("两次新密码不一致");
        return;
      }
      const { data } = await http.post("/api/change-password", {
        oldPassword: pwdDialog.oldPassword,
        newPassword: pwdDialog.newPassword,
        newUsername: pwdDialog.newUsername || undefined,
      });
      if (data.code === 0) {
        localStorage.setItem("token", data.data.token);
        localStorage.setItem("username", data.data.username);
        username.value = data.data.username;
        ElMessage.success("修改成功");
        pwdDialog.visible = false;
      }
    };

    // ----- 退出 -----
    const logout = () => {
      localStorage.removeItem("token");
      localStorage.removeItem("username");
      emit("logout");
    };

    // 树过滤 — 模糊子序列匹配（忽略大小写，支持分散字符）
    const filterNode = (value, data) => {
      if (!value) return true;
      // 虚拟根节点始终显示
      if (data._virtual) return true;
      const query = value.toLowerCase();
      const target = data.name.toLowerCase();
      // 先尝试 includes 快速路径
      if (target.includes(query)) return true;
      // 子序列匹配：query 的每个字符按顺序出现在 target 中即可
      let qi = 0;
      for (let ti = 0; ti < target.length && qi < query.length; ti++) {
        if (target[ti] === query[qi]) qi++;
      }
      return qi === query.length;
    };
    const onFilterChange = (v) => {
      treeRef.value?.filter(v);
    };

    onMounted(() => {
      loadTags();
      loadFiles();
      loadTagCloud();
      loadStats();
    });

    return {
      username,
      tags,
      tagTree,
      treeRef,
      filterText,
      editDialog,
      pwdDialog,
      importDialog,
      parentOptions,
      parsedTags,
      openCreate,
      openEdit,
      submitEdit,
      removeTag,
      batchMoveDialog,
      openBatchMove,
      batchMoveParentOptions,
      submitBatchMove,
      allowTreeDrag,
      allowTreeDrop,
      onTreeNodeDrop,
      openPwd,
      submitPwd,
      openImport,
      submitImport,
      removeParsed,
      logout,
      filterNode,
      onFilterChange,
      // 文件名生成器
      fileName,
      selectedTags,
      finalName,
      checkedKeys,
      onTreeCheck,
      removeSelected,
      moveSelected,
      clearSelected,

      onDragStart,
      onDragOver,
      onDrop,
      copyFinal,
      // 标签云
      tagCloudData,
      tagCloudLoading,
      tagCloudPositions,
      tagCloudContainerRef,
      tagCloudView,
      tagCloudCanvasStyle,
      tagItemOffsets,
      onTagCloudWheel,
      onTagCloudMouseDown,
      onTagCloudMouseMove,
      onTagCloudMouseUp,
      onTagCloudItemClick,
      onTagItemMouseDown,
      resetTagCloudView,
      // 保存与文件列表
      saveLoading,
      saveFinal,
      fileImportDialog,
      fileImportParsed,
      openFileImport,
      handleFileImportUpload,
      submitFileImport,
      importProgress,
      exportDialog,
      openExportDialog,
      exportFiles,
      fileList,
      fileQuery,
      fileLoading,
      filePagination,
      loadFiles,
      onPageChange,
      onPageSizeChange,
      resetFileQuery,
      filterByTag,
      removeFileTag,
      inlineAddTagState,
      showInlineAddTag,
      hideInlineAddTag,
      submitInlineAddTag,
      onFileQueryTagChange,
      tagTreeNoVirtual,
      genTagPickIds,
      onGenTagPick,
      selectedFiles,
      onSelectionChange,
      batchTagDialog,
      openBatchAddTag,
      openBatchRemoveTag,
      submitBatchTag,
      batchDeleteFiles,
      removeFile,
      copyFileName,
      fileEditDialog,
      openFileEdit,
      submitFileEdit,
      // 行内重命名
      inlineRenameId,
      inlineRenameName,
      startInlineRename,
      cancelInlineRename,
      submitInlineRename,
      // 批量文件名替换
      batchRenameDialog,
      openBatchRename,
      batchRenamePreview,
      submitBatchRename,
      // 统计列表
      statsData,
      statsTotal,
      statsLoading,
      statsQuery,
      loadStats,
      resetStats,
      // 左侧树折叠
      treeCollapsed,
      // 各卡片折叠
      genCollapsed,
      tagCloudCollapsed,
      filesCollapsed,
      statsCollapsed,
    };
  },
  template: `
    <div class="layout">
      <div class="topbar">
        <div class="title">🏷️ Tag 管理系统 <span class="version-badge">v1.5.0</span></div>
        <div class="right">
          <el-popover placement="bottom-start" :width="360" trigger="click">
            <template #reference>
              <el-button size="small" type="info" plain>📋 更新日志</el-button>
            </template>
            <div class="changelog">
              <h4 style="margin:0 0 10px;">功能更新说明</h4>
              <div class="changelog-item">
                <div class="changelog-version">v1.5.0 <span class="changelog-date">2025-06-13</span></div>
                <ul>
                  <li>新增文件统计面板（支持按标签/日期统计文件数量）</li>
                  <li>统计支持日期范围与标签范围筛选</li>
                </ul>
              </div>
              <div class="changelog-item">
                <div class="changelog-version">v1.4.0 <span class="changelog-date">2025-06-10</span></div>
                <ul>
                  <li>新增批量文件名替换功能</li>
                  <li>新增标签云展示（云朵分布、悬停显示文件数）</li>
                </ul>
              </div>
              <div class="changelog-item">
                <div class="changelog-version">v1.3.0 <span class="changelog-date">2025-06-06</span></div>
                <ul>
                  <li>新增文件导入/导出功能</li>
                  <li>支持 [YYYYMMDD] 日期格式解析</li>
                </ul>
              </div>
              <div class="changelog-item">
                <div class="changelog-version">v1.2.0 <span class="changelog-date">2025-05-28</span></div>
                <ul>
                  <li>新增批量移动标签</li>
                  <li>文件名生成器支持拖拽排序标签</li>
                </ul>
              </div>
              <div class="changelog-item">
                <div class="changelog-version">v1.1.0 <span class="changelog-date">2025-05-20</span></div>
                <ul>
                  <li>新增标签树层级管理</li>
                  <li>支持标签拖拽排序</li>
                </ul>
              </div>
              <div class="changelog-item">
                <div class="changelog-version">v1.0.0 <span class="changelog-date">2025-05-10</span></div>
                <ul>
                  <li>基础登录/注册</li>
                  <li>标签增删改查</li>
                  <li>文件管理与标签关联</li>
                </ul>
              </div>
            </div>
          </el-popover>
          <span style="color:#606266;">{{ username }}</span>
          <el-button size="small" @click="openPwd">修改账号/密码</el-button>
          <el-button size="small" type="danger" plain @click="logout">退出</el-button>
        </div>
      </div>

      <div class="main">
        <div class="split">
          <div class="tree-card" :class="{ 'tree-collapsed': treeCollapsed }">
            <div v-show="!treeCollapsed" class="tree-toggle-btn" @click="treeCollapsed = true" title="收起标签面板">
              <span class="tree-toggle-arrow">◀</span>
            </div>
            <div v-if="treeCollapsed" class="tree-collapsed-inner" @click="treeCollapsed = false">
              <div class="tree-collapsed-label">标签</div>
              <div class="tree-expand-btn" title="展开标签面板">
                <span class="tree-toggle-arrow">▶</span>
              </div>
            </div>
            <div v-show="!treeCollapsed" class="tree-card-body">
              <div class="tree-toolbar">
                <div class="tree-toolbar-row">
                  <el-button size="small" type="success" @click="openImport">📋 粘贴文本导入</el-button>
                  <el-input
                    v-model="filterText"
                    placeholder="搜索 Tag 名称"
                    clearable
                    size="small"
                    style="flex:1;"
                    @input="onFilterChange"
                  />
                </div>
                <div class="tree-toolbar-row">
                  <el-button size="small" type="primary" plain @click="openCreate(null)">+ 新建顶级 Tag</el-button>
                  <el-button size="small" type="warning" plain @click="openBatchMove">📦 批量移动</el-button>
                  <span style="color:#909399;font-size:12px;margin-left:auto;">共 {{ tags.length }} 个</span>
                </div>
              </div>
              <div v-if="!tags.length" class="empty-tip">暂无 Tag，点击上方按钮创建第一个吧</div>
              <el-tree
                v-else
                ref="treeRef"
                :data="tagTree"
                node-key="id"
                default-expand-all
                show-checkbox
                draggable
                :default-checked-keys="checkedKeys"
                :expand-on-click-node="false"
                :filter-node-method="filterNode"
                :allow-drop="allowTreeDrop"
                :allow-drag="allowTreeDrag"
                @check="onTreeCheck"
                @node-drop="onTreeNodeDrop"
              >
                <template #default="{ node, data }">
                  <div class="tag-node">
                    <template v-if="data._virtual">
                      <span class="name" style="font-weight:600;color:#409eff;">
                        {{ data.name }}<span class="tag-child-count">({{ data.childCount }})</span>
                      </span>
                    </template>
                    <template v-else>
                      <span class="actions">
                        <button
                          class="icon-btn icon-add"
                          title="新增子级"
                          @click.stop="openCreate(data.id)"
                        >+</button>
                        <button
                          class="icon-btn icon-del"
                          title="删除"
                          @click.stop="removeTag(data)"
                        >×</button>
                      </span>
                      <span class="name name-clickable" @click.stop="openEdit(data)" :title="'点击编辑：' + data.name">
                        {{ data.name }}<span v-if="data.childCount > 0" class="tag-child-count">({{ data.childCount }})</span>
                        <span class="tag-meta">#{{ data.id }}</span>
                        <span v-if="data.priority > 0" class="tag-priority-badge" :title="'优先级: ' + data.priority">⬆{{ data.priority }}</span>
                      </span>
                    </template>
                  </div>
                </template>
              </el-tree>
            </div>
          </div>

          <div class="gen-card">
            <div class="card-header-toggle" @click="genCollapsed = !genCollapsed">
              <div class="gen-title" style="margin-bottom:0;">📝 文件名生成器</div>
              <span class="card-toggle-arrow">{{ genCollapsed ? '▼' : '▲' }}</span>
            </div>
            <div v-show="!genCollapsed" class="card-collapsible-body">
            <div class="gen-row">
              <span class="gen-label">文件名</span>
              <el-input
                v-model="fileName"
                placeholder="例如 abc-123_加西亚.马尔克斯（自动转小写）"
                clearable
              />
            </div>
            <div class="gen-row">
              <span class="gen-label">已选标签</span>
              <div style="flex:1;">
                <el-tree-select
                  v-model="genTagPickIds"
                  :data="tagTreeNoVirtual"
                  :props="{ value: 'id', label: 'name', children: 'children' }"
                  node-key="id"
                  multiple
                  check-strictly
                  filterable
                  clearable
                  collapse-tags
                  collapse-tags-tooltip
                  placeholder="搜索并选择标签"
                  style="width:100%;margin-bottom:8px;"
                  @change="onGenTagPick"
                />
                <div v-if="!selectedTags.length" class="empty-sub">在左侧勾选标签或上方搜索选择，可拖拽排序</div>
                <div v-else class="picked-list">
                  <div
                    v-for="(t, idx) in selectedTags"
                    :key="t.id"
                    class="picked-item"
                    draggable="true"
                    @dragstart="onDragStart(idx)"
                    @dragover="onDragOver"
                    @drop="onDrop(idx)"
                    :title="'拖拽排序，序号 ' + (idx+1)"
                  >
                    <span class="picked-idx">{{ idx + 1 }}</span>
                    <span class="picked-name">{{ t.name }}</span>
                    <el-button size="small" link :disabled="idx===0" @click="moveSelected(idx,-1)">↑</el-button>
                    <el-button size="small" link :disabled="idx===selectedTags.length-1" @click="moveSelected(idx,1)">↓</el-button>
                    <el-button size="small" link type="danger" @click="removeSelected(t.id)">×</el-button>
                  </div>
                </div>
                <div v-if="selectedTags.length" style="margin-top:6px;">
                  <el-button size="small" @click="clearSelected">清空已选</el-button>
                </div>
              </div>
            </div>
            <div class="gen-row">
              <span class="gen-label">最终结果</span>
              <div style="flex:1;display:flex;gap:8px;align-items:center;">
                <el-input :model-value="finalName" readonly class="final-input" />
                <el-button type="primary" @click="copyFinal">复制</el-button>
                <el-button type="success" :loading="saveLoading" :disabled="!finalName" @click="saveFinal">保存</el-button>
              </div>
            </div>
            <div class="gen-tip">
              格式：<code>[当日日期]&lt;文件名小写&gt;_&lt;tag1.tag2.tag3&gt;</code>
            </div>

            </div>

            <!-- 标签云 -->
            <div class="tag-cloud-section" :class="{ 'card-section-collapsed': tagCloudCollapsed }">
              <div class="card-header-toggle" @click="tagCloudCollapsed = !tagCloudCollapsed">
                <div class="tag-cloud-title" style="margin-bottom:0;">☁️ 标签云</div>
                <span class="card-toggle-arrow">{{ tagCloudCollapsed ? '▼' : '▲' }}</span>
              </div>
              <div v-show="!tagCloudCollapsed" v-loading="tagCloudLoading" class="tag-cloud-body">
              <div class="tag-cloud-tools-bar">
                <span class="tag-cloud-tools">
                  <span class="tag-cloud-zoom">{{ Math.round(tagCloudView.scale * 100) }}%</span>
                  <el-button size="small" link @click="resetTagCloudView" title="重置视图">⟳ 重置</el-button>
                </span>
              </div>
              <div v-if="!tagCloudData.length" style="color:#c0c4cc;font-size:13px;text-align:center;padding:20px 0;">暂无标签使用数据</div>
              <div
                v-else
                ref="tagCloudContainerRef"
                class="tag-cloud-container"
                @wheel.prevent="onTagCloudWheel"
                @mousedown="onTagCloudMouseDown"
                @mousemove="onTagCloudMouseMove"
                @mouseup="onTagCloudMouseUp"
                @mouseleave="onTagCloudMouseUp"
              >
                <div :style="tagCloudCanvasStyle">
                  <el-tooltip v-for="t in tagCloudPositions" :key="t.id" :content="t.name + '（' + t.count + ' 个文件）'" placement="top" :show-after="300">
                    <span
                      :style="t.style"
                      class="tag-cloud-item"
                      @mousedown="onTagItemMouseDown(t, $event)"
                      @click="onTagCloudItemClick(t, $event)"
                    >{{ t.name }}</span>
                  </el-tooltip>
                </div>
                <div class="tag-cloud-hint">滚轮缩放 · 拖拽平移</div>
              </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 文件列表 -->
        <div class="files-card">
          <div class="card-header-toggle" @click="filesCollapsed = !filesCollapsed">
            <div class="files-header" style="margin-bottom:0;">
              <div class="files-title">📁 文件列表 <span class="files-count">共 {{ filePagination.total }} 个</span></div>
              <div class="files-actions" @click.stop>
                <el-button size="small" type="success" @click="openFileImport">导入</el-button>
                <el-button size="small" type="warning" @click="openExportDialog">导出</el-button>
              </div>
            </div>
            <span class="card-toggle-arrow">{{ filesCollapsed ? '▼' : '▲' }}</span>
          </div>
          <div v-show="!filesCollapsed" class="card-collapsible-body">
          <div class="files-filter">
            <el-input
              v-model="fileQuery.keyword"
              placeholder="按文件名模糊搜索"
              clearable
              style="width:220px"
              @keyup.enter="loadFiles"
              @clear="loadFiles"
            />
            <el-tree-select
              v-model="fileQuery.tagIds"
              :data="tagTreeNoVirtual"
              :props="{ value: 'id', label: 'name', children: 'children' }"
              node-key="id"
              multiple
              check-strictly
              filterable
              clearable
              collapse-tags
              collapse-tags-tooltip
              placeholder="按标签筛选"
              style="width:260px"
              @change="onFileQueryTagChange"
            />
            <el-date-picker
              v-model="fileQuery.dateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              format="YYYY-MM-DD"
              value-format="YYYY-MM-DD"
              clearable
              style="width:260px"
              @change="() => { filePagination.page = 1; loadFiles(); }"
            />
            <el-radio-group v-model="fileQuery.mode" size="small" @change="loadFiles">
              <el-radio-button label="all">AND</el-radio-button>
              <el-radio-button label="any">OR</el-radio-button>
            </el-radio-group>
            <el-button type="primary" @click="loadFiles">查询</el-button>
            <el-button @click="resetFileQuery">重置</el-button>
          </div>

          <div v-if="selectedFiles.length" style="margin-top:12px;margin-bottom:8px;display:flex;align-items:center;gap:10px;">
            <span style="color:#606266;font-size:13px;">已选 {{ selectedFiles.length }} 项</span>
            <el-button size="small" type="primary" @click="openBatchAddTag">+ 批量添加标签</el-button>
            <el-button size="small" type="warning" @click="openBatchRemoveTag">- 批量移除标签</el-button>
            <el-button size="small" type="info" @click="openBatchRename">✏️ 批量替换文件名</el-button>
            <el-button size="small" type="danger" @click="batchDeleteFiles">批量删除</el-button>
          </div>

          <el-table
            v-loading="fileLoading"
            :data="fileList"
            stripe
            style="width:100%;margin-top:12px;"
            empty-text="暂无文件，在上方生成器中点击 保存 即可"
            @selection-change="onSelectionChange"
          >
            <el-table-column type="selection" width="45" />
            <el-table-column prop="id" label="ID" width="70" />
            <el-table-column label="日期" width="110" sortable :sort-method="(a,b) => a.createdAt < b.createdAt ? -1 : 1">
              <template #default="{ row }">
                <span>{{ row.createdAt ? row.createdAt.slice(0, 10) : '-' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="文件名" min-width="260">
              <template #default="{ row }">
                <div v-if="inlineRenameId === row.id" style="display:flex;align-items:center;gap:4px;">
                  <el-input
                    v-model="inlineRenameName"
                    size="small"
                    style="flex:1;"
                    @keyup.enter="submitInlineRename(row)"
                    @keyup.escape="cancelInlineRename"
                  />
                  <el-button size="small" type="primary" link @click="submitInlineRename(row)">✓</el-button>
                  <el-button size="small" link @click="cancelInlineRename">✗</el-button>
                </div>
                <span v-else style="font-family:SFMono-Regular,Consolas,Menlo,monospace;word-break:break-all;cursor:pointer;" @dblclick="startInlineRename(row)" title="双击重命名">{{ row.name }}</span>
              </template>
            </el-table-column>
            <el-table-column label="标签" min-width="260">
              <template #default="{ row }">
                <div style="display:flex;flex-wrap:wrap;gap:4px;align-items:center;">
                  <template v-if="!row.tags.length && inlineAddTagState.fileId !== row.id">
                    <span style="color:#c0c4cc;">-</span>
                  </template>
                  <el-tag v-for="t in row.tags" :key="t.id" size="small" type="info" closable style="cursor:pointer;" @click="filterByTag(t)" @close="removeFileTag(row, t)">{{ t.name }}</el-tag>
                  <el-popover :visible="inlineAddTagState.fileId === row.id" placement="bottom" :width="240" @hide="hideInlineAddTag">
                    <template #reference>
                      <el-tag size="small" style="cursor:pointer;border-style:dashed;" @click="showInlineAddTag(row)">+</el-tag>
                    </template>
                    <div style="display:flex;flex-direction:column;gap:8px;" @keyup.enter="submitInlineAddTag(row)">
                      <el-select
                        v-model="inlineAddTagState.tagIds"
                        multiple
                        filterable
                        allow-create
                        default-first-option
                        placeholder="选择或输入新标签"
                        size="small"
                        style="width:100%;"
                      >
                        <el-option v-for="t in tags" :key="t.id" :label="t.name" :value="t.id" />
                      </el-select>
                      <div style="color:#909399;font-size:11px;">输入不存在的标签名可直接创建，回车确认</div>
                      <div style="display:flex;justify-content:flex-end;gap:6px;">
                        <el-button size="small" @click="hideInlineAddTag">取消</el-button>
                        <el-button size="small" type="primary" @click="submitInlineAddTag(row)">确定</el-button>
                      </div>
                    </div>
                  </el-popover>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="createdAt" label="保存时间" width="160" sortable />
            <el-table-column prop="updatedAt" label="更新时间" width="160" sortable />
            <el-table-column label="操作" width="260" fixed="right">
              <template #default="{ row }">
                <el-button size="small" link type="primary" @click="copyFileName(row)">复制</el-button>
                <el-button size="small" link @click="openFileEdit(row)">编辑</el-button>
                <el-button size="small" link type="danger" @click="removeFile(row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>

          <div class="files-pagination">
            <el-pagination
              v-model:current-page="filePagination.page"
              v-model:page-size="filePagination.pageSize"
              :total="filePagination.total"
              :page-sizes="[10, 20, 50, 100, 500, 1000]"
              layout="total, sizes, prev, pager, next, jumper"
              background
              @current-change="onPageChange"
              @size-change="onPageSizeChange"
            />
          </div>
          </div>
        </div>

        <!-- 统计列表 -->
        <div class="stats-card">
          <div class="card-header-toggle" @click="statsCollapsed = !statsCollapsed">
            <div class="stats-title">📊 文件统计 <span class="stats-count">共 {{ statsTotal }} 个文件</span></div>
            <span class="card-toggle-arrow">{{ statsCollapsed ? '▼' : '▲' }}</span>
          </div>
          <div v-show="!statsCollapsed" class="card-collapsible-body">
          <div class="stats-filter">
            <el-radio-group v-model="statsQuery.groupBy" size="small" @change="loadStats">
              <el-radio-button label="tag">按标签</el-radio-button>
              <el-radio-button label="date">按日期</el-radio-button>
            </el-radio-group>
            <el-date-picker
              v-model="statsQuery.dateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              format="YYYY-MM-DD"
              value-format="YYYY-MM-DD"
              clearable
              size="small"
              style="width:240px"
              @change="loadStats"
            />
            <el-tree-select
              v-model="statsQuery.tagIds"
              :data="tagTreeNoVirtual"
              :props="{ value: 'id', label: 'name', children: 'children' }"
              node-key="id"
              multiple
              check-strictly
              filterable
              clearable
              collapse-tags
              collapse-tags-tooltip
              placeholder="限定标签范围"
              size="small"
              style="width:220px"
              @change="loadStats"
            />
            <el-button size="small" @click="resetStats">重置</el-button>
          </div>
          <el-table
            v-loading="statsLoading"
            :data="statsData"
            stripe
            size="small"
            style="width:100%;margin-top:10px;"
            max-height="360"
            empty-text="暂无统计数据"
          >
            <el-table-column type="index" label="#" width="50" />
            <el-table-column prop="label" :label="statsQuery.groupBy === 'tag' ? '标签' : '日期'" min-width="180">
              <template #default="{ row }">
                <span v-if="statsQuery.groupBy === 'tag'" style="cursor:pointer;color:#409eff;" @click="filterByTag({id: row.id, name: row.label})">{{ row.label }}</span>
                <span v-else>{{ row.label }}</span>
              </template>
            </el-table-column>
            <el-table-column prop="count" label="文件数" width="120" sortable />
            <el-table-column label="占比" width="180">
              <template #default="{ row }">
                <el-progress :percentage="statsTotal ? Math.round(row.count / statsTotal * 100) : 0" :stroke-width="14" :text-inside="true" style="width:100%;" />
              </template>
            </el-table-column>
          </el-table>
          </div>
        </div>
      </div>

      <!-- 编辑文件 -->
      <!-- 导出对话框 -->
      <el-dialog v-model="exportDialog.visible" title="导出文件" width="520px">
        <el-form label-width="90px">
          <el-form-item label="选择标签">
            <el-tree-select
              v-model="exportDialog.tagIds"
              :data="tagTree"
              :props="{ value: 'id', label: 'name', children: 'children' }"
              node-key="id"
              multiple
              check-strictly
              filterable
              clearable
              collapse-tags
              collapse-tags-tooltip
              placeholder="不选则导出所有文件"
              style="width:100%"
            />
          </el-form-item>
          <el-form-item label="排序方式">
            <el-radio-group v-model="exportDialog.sort">
              <el-radio label="name">按文件名排序</el-radio>
              <el-radio label="date">按日期排序</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="按标签分组">
            <el-switch v-model="exportDialog.group" />
            <span style="margin-left:8px;color:#909399;font-size:12px;">开启后按标签分类展示</span>
          </el-form-item>
        </el-form>
        <div style="background:#f5f7fa;border-radius:6px;padding:12px 14px;margin-top:4px;">
          <div style="font-size:12px;color:#909399;margin-bottom:6px;">导出格式预览：</div>
          <pre style="margin:0;font-size:12px;color:#606266;line-height:1.8;white-space:pre-wrap;">{{ exportDialog.group ? '[分类1]\\n[20260612]xxx_tag1.tag2\\n[20260612]yyy_tag1.tag3\\n\\n[分类2]\\n[20260612]zzz_tag2.tag4' : '[20260612]xxx_tag1.tag2\\n[20260612]yyy_tag1.tag3' }}</pre>
        </div>
        <template #footer>
          <el-button @click="exportDialog.visible=false">取消</el-button>
          <el-button type="warning" @click="exportFiles">确认导出</el-button>
        </template>
      </el-dialog>

      <el-dialog v-model="fileEditDialog.visible" title="编辑文件" width="520px">
        <el-form label-width="80px">
          <el-form-item label="文件名">
            <el-input v-model="fileEditDialog.name" placeholder="请输入文件名" maxlength="200" show-word-limit />
          </el-form-item>
          <el-form-item label="标签">
            <el-tree-select
              v-model="fileEditDialog.tagIds"
              :data="tagTree"
              :props="{ value: 'id', label: 'name', children: 'children' }"
              node-key="id"
              multiple
              check-strictly
              filterable
              clearable
              collapse-tags
              collapse-tags-tooltip
              placeholder="选择标签"
              style="width:100%"
            />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="fileEditDialog.visible=false">取消</el-button>
          <el-button type="primary" :loading="fileEditDialog.loading" @click="submitFileEdit">保存</el-button>
        </template>
      </el-dialog>

      <!-- 导入文件 -->
      <el-dialog v-model="fileImportDialog.visible" title="导入文件" width="640px">
        <div style="color:#606266;font-size:13px;margin-bottom:8px;line-height:1.6;">
          支持粘贴文本或上传 txt 文件。每行一条，格式：<code>[日期]文件名_标签1.标签2.标签3</code><br/>
          示例：<code>[20260612]abc-123_标签1.标签2.标签3</code> → 文件名 <b>abc-123</b>，标签 <b>标签1 / 标签2 / 标签3</b><br/>
          标签不存在时会自动创建为顶级标签。
        </div>
        <div style="margin-bottom:8px;">
          <el-upload
            :show-file-list="false"
            accept=".txt"
            :auto-upload="false"
            :on-change="handleFileImportUpload"
          >
            <el-button size="small" type="primary" plain>选择 txt 文件</el-button>
          </el-upload>
        </div>
        <el-input
          v-model="fileImportDialog.text"
          type="textarea"
          :rows="8"
          placeholder="将文本粘贴到这里，每行一条..."
        />
        <div style="margin-top:12px;">
          <div style="color:#606266;margin-bottom:6px;">
            预览（{{ fileImportParsed.length }} 条）：
          </div>
          <div v-if="!fileImportParsed.length" style="color:#c0c4cc;font-size:13px;">尚未解析到任何文件</div>
          <div v-else style="max-height:180px;overflow:auto;border:1px solid #ebeef5;border-radius:4px;padding:8px;">
            <div v-for="(item, idx) in fileImportParsed" :key="idx" style="margin-bottom:4px;font-size:13px;">
              <span style="color:#303133;font-weight:500;">{{ item.fileName }}</span>
              <el-tag v-for="t in item.tagNames" :key="t" size="small" type="info" style="margin-left:4px;">{{ t }}</el-tag>
            </div>
          </div>
        </div>
        <template #footer>
          <el-button @click="fileImportDialog.visible=false">取消</el-button>
          <el-button
            type="primary"
            :loading="fileImportDialog.loading"
            :disabled="!fileImportParsed.length"
            @click="submitFileImport"
          >导入 {{ fileImportParsed.length ? '(' + fileImportParsed.length + ' 条)' : '' }}</el-button>
        </template>
      </el-dialog>

      <!-- 导入进度 -->
      <el-dialog v-model="importProgress.visible" title="正在导入..." width="400px" :close-on-click-modal="false" :show-close="false">
        <div style="text-align:center;padding:20px 0;">
          <el-progress :percentage="importProgress.total ? Math.round(importProgress.created / importProgress.total * 100) : 0" :stroke-width="16" style="margin-bottom:16px;" />
          <p style="color:#606266;font-size:14px;">已导入 {{ importProgress.created }} / {{ importProgress.total }} 条</p>
        </div>
      </el-dialog>

      <!-- 新增/编辑 Tag -->
      <el-dialog v-model="editDialog.visible" :title="editDialog.title" width="460px">
        <el-form label-width="80px">
          <el-form-item label="名称">
            <el-input v-model="editDialog.name" placeholder="请输入 tag 名称" maxlength="50" show-word-limit />
          </el-form-item>
          <el-form-item label="父级">
            <el-tree-select
              v-model="editDialog.parentId"
              :data="parentOptions"
              :props="{ value: 'id', label: 'name', children: 'children' }"
              node-key="id"
              check-strictly
              clearable
              placeholder="不选则为顶级"
              style="width:100%"
            />
          </el-form-item>
          <el-form-item label="优先级">
            <el-input-number v-model="editDialog.priority" :min="0" :max="999" :step="1" controls-position="right" style="width:160px" />
            <span style="margin-left:8px;color:#909399;font-size:12px">数字越小，优先级越高，导出时排越前</span>
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="editDialog.visible=false">取消</el-button>
          <el-button type="primary" @click="submitEdit">确定</el-button>
        </template>
      </el-dialog>

      <!-- 批量移动 Tag -->
      <el-dialog v-model="batchMoveDialog.visible" title="批量移动标签" width="420px">
        <p style="color:#606266;font-size:13px;margin-bottom:12px;">
          将左侧树中勾选的标签移动到指定的父标签下（不选则移动到顶级）。
        </p>
        <el-form label-width="80px">
          <el-form-item label="目标父级">
            <el-tree-select
              v-model="batchMoveDialog.targetParentId"
              :data="batchMoveParentOptions"
              :props="{ value: 'id', label: 'name', children: 'children' }"
              node-key="id"
              check-strictly
              clearable
              placeholder="不选则移动到顶级"
              style="width:100%"
            />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="batchMoveDialog.visible=false">取消</el-button>
          <el-button type="primary" :loading="batchMoveDialog.loading" @click="submitBatchMove">确定移动</el-button>
        </template>
      </el-dialog>

      <!-- 批量添加/移除标签 -->
      <el-dialog v-model="batchTagDialog.visible" :title="batchTagDialog.mode === 'add' ? '批量添加标签' : '批量移除标签'" width="460px">
        <p style="color:#606266;font-size:13px;margin-bottom:12px;">
          {{ batchTagDialog.mode === 'add' ? '为选中的文件添加以下标签：' : '从选中的文件移除以下标签：' }}
        </p>
        <el-tree-select
          v-model="batchTagDialog.tagIds"
          :data="tagTreeNoVirtual"
          :props="{ value: 'id', label: 'name', children: 'children' }"
          node-key="id"
          multiple
          check-strictly
          filterable
          clearable
          collapse-tags
          collapse-tags-tooltip
          placeholder="搜索并选择标签"
          style="width:100%"
        />
        <template #footer>
          <el-button @click="batchTagDialog.visible=false">取消</el-button>
          <el-button :type="batchTagDialog.mode === 'add' ? 'primary' : 'warning'" :loading="batchTagDialog.loading" @click="submitBatchTag">确定</el-button>
        </template>
      </el-dialog>

      <!-- 批量替换文件名 -->
      <el-dialog v-model="batchRenameDialog.visible" title="批量替换文件名" width="560px">
        <p style="color:#606266;font-size:13px;margin-bottom:12px;">
          对选中的 {{ selectedFiles.length }} 个文件执行文件名查找替换操作。
        </p>
        <el-form label-width="80px">
          <el-form-item label="查找">
            <el-input v-model="batchRenameDialog.search" :placeholder="batchRenameDialog.useRegex ? '输入正则表达式，如 ^abc|\\\\d+' : '输入要查找的字符串'" clearable />
          </el-form-item>
          <el-form-item label="替换为">
            <el-input v-model="batchRenameDialog.replace" :placeholder="batchRenameDialog.useRegex ? '支持 $1、$2 等捕获组引用（留空则删除）' : '替换为（留空则删除匹配内容）'" clearable />
          </el-form-item>
          <el-form-item label="正则">
            <el-switch v-model="batchRenameDialog.useRegex" active-text="启用正则表达式" />
          </el-form-item>
        </el-form>
        <div v-if="batchRenameDialog.regexError" style="color:#f56c6c;font-size:12px;margin-top:4px;margin-bottom:8px;">
          ⚠️ {{ batchRenameDialog.regexError }}
        </div>
        <div v-if="batchRenameDialog.useRegex && !batchRenameDialog.regexError" style="color:#909399;font-size:12px;margin-bottom:8px;">
          💡 提示：替换串中可使用 <code>$1</code>、<code>$2</code> 引用捕获组，<code>$&</code> 引用整个匹配
        </div>
        <div v-if="batchRenameDialog.search" style="margin-top:8px;">
          <div style="color:#606266;margin-bottom:6px;font-size:13px;">
            预览（{{ batchRenamePreview.length }} 个文件将被修改）：
          </div>
          <div v-if="!batchRenamePreview.length && !batchRenameDialog.regexError" style="color:#c0c4cc;font-size:13px;">没有匹配到包含该字符串的文件</div>
          <div v-else-if="batchRenamePreview.length" style="max-height:200px;overflow:auto;border:1px solid #ebeef5;border-radius:4px;padding:8px;">
            <div v-for="item in batchRenamePreview" :key="item.id" style="margin-bottom:6px;font-size:13px;line-height:1.6;">
              <div><span style="color:#909399;">原：</span><span style="text-decoration:line-through;color:#f56c6c;">{{ item.oldName }}</span></div>
              <div><span style="color:#909399;">新：</span><span style="color:#67c23a;font-weight:500;">{{ item.newName }}</span></div>
            </div>
          </div>
        </div>
        <template #footer>
          <el-button @click="batchRenameDialog.visible=false">取消</el-button>
          <el-button type="primary" :loading="batchRenameDialog.loading" :disabled="!batchRenamePreview.length" @click="submitBatchRename">确定替换</el-button>
        </template>
      </el-dialog>

      <!-- 批量导入 Tag -->
      <el-dialog v-model="importDialog.visible" title="粘贴文本批量导入" width="640px">
        <div style="color:#606266;font-size:13px;margin-bottom:8px;line-height:1.6;">
          规则：取每行最后一个 <code>_</code> 之后的部分，按 <code>.</code> 拆分为多个标签。<br/>
          示例：<code>[20260612]abc-123_加西亚.马尔克斯_标签1.标签2.标签3</code> → <b>标签1 / 标签2 / 标签3</b><br/>
          支持多行批量粘贴，自动去重。
        </div>
        <el-input
          v-model="importDialog.text"
          type="textarea"
          :rows="6"
          placeholder="将原始文本粘贴到这里，每行一条..."
        />
        <div style="margin-top:12px;">
          <span style="color:#606266;">导入到父级：</span>
          <el-tree-select
            v-model="importDialog.parentId"
            :data="parentOptions"
            :props="{ value: 'id', label: 'name', children: 'children' }"
            node-key="id"
            check-strictly
            clearable
            placeholder="不选则为顶级"
            style="width:340px;vertical-align:middle;"
          />
        </div>
        <div style="margin-top:14px;">
          <div style="color:#606266;margin-bottom:6px;">
            预览（{{ parsedTags.length }} 个）：
          </div>
          <div v-if="!parsedTags.length" style="color:#c0c4cc;font-size:13px;">尚未解析到任何标签</div>
          <div v-else style="display:flex;flex-wrap:wrap;gap:6px;max-height:160px;overflow:auto;">
            <el-tag
              v-for="t in parsedTags"
              :key="t"
              closable
              type="success"
              @close="removeParsed(t)"
            >{{ t }}</el-tag>
          </div>
        </div>
        <template #footer>
          <el-button @click="importDialog.visible=false">取消</el-button>
          <el-button
            type="primary"
            :loading="importDialog.loading"
            :disabled="!parsedTags.length"
            @click="submitImport"
          >导入 {{ parsedTags.length ? '(' + parsedTags.length + ')' : '' }}</el-button>
        </template>
      </el-dialog>

      <!-- 修改账号/密码 -->
      <el-dialog v-model="pwdDialog.visible" title="修改账号 / 密码" width="460px">
        <el-form label-width="100px">
          <el-form-item label="当前密码">
            <el-input v-model="pwdDialog.oldPassword" type="password" show-password />
          </el-form-item>
          <el-form-item label="新账号">
            <el-input v-model="pwdDialog.newUsername" placeholder="留空则不修改账号" />
          </el-form-item>
          <el-form-item label="新密码">
            <el-input v-model="pwdDialog.newPassword" type="password" show-password />
          </el-form-item>
          <el-form-item label="确认新密码">
            <el-input v-model="pwdDialog.newPassword2" type="password" show-password @keyup.enter="submitPwd" />
          </el-form-item>
        </el-form>
        <template #footer>
          <el-button @click="pwdDialog.visible=false">取消</el-button>
          <el-button type="primary" @click="submitPwd">提交</el-button>
        </template>
      </el-dialog>
    </div>
  `,
};

// ---------- 工具函数 ----------
function buildTree(flat) {
  const map = new Map();
  const roots = [];
  flat.forEach((t) => map.set(t.id, { ...t, children: [] }));
  map.forEach((node) => {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId).children.push(node);
    } else {
      roots.push(node);
    }
  });
  // 计算子标签个数并清理空 children
  const trim = (nodes) =>
    nodes.map((n) => {
      const o = { ...n };
      o.childCount = o.children.length;
      if (o.children.length) o.children = trim(o.children);
      else delete o.children;
      return o;
    });
  return trim(roots);
}

// 在选择父级时，移除自身与自身的子孙节点
function pruneSelf(tree, selfId) {
  const result = [];
  for (const node of tree) {
    if (node.id === selfId) continue;
    const copy = { ...node };
    if (copy.children) copy.children = pruneSelf(copy.children, selfId);
    result.push(copy);
  }
  return result;
}

// ---------- 根组件 ----------
const App = {
  components: { LoginView, HomeView },
  setup() {
    const logged = ref(!!localStorage.getItem("token"));
    const onLogin = () => { logged.value = true; };
    const onLogout = () => { logged.value = false; };
    window.addEventListener("force-logout", onLogout);
    return { logged, onLogin, onLogout };
  },
  template: `
    <login-view v-if="!logged" @login-success="onLogin" />
    <home-view v-else @logout="onLogout" />
  `,
};

const app = createApp(App);
app.use(ElementPlus, { locale: ElementPlusLocaleZhCn });
for (const [key, comp] of Object.entries(ElementPlusIconsVue)) {
  app.component(key, comp);
}
app.mount("#app");
