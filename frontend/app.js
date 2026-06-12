/* global Vue, ElementPlus, ElementPlusIconsVue, axios */

const { createApp, ref, reactive, computed, onMounted, h } = Vue;
const { ElMessage, ElMessageBox } = ElementPlus;

// API 基础地址：与后端同源时为空（由 Flask 静态托管），独立运行时可以改成 http://localhost:5050
const API_BASE = (location.port === "5050" || location.protocol === "file:") ? "" : "http://localhost:5050";

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

    // 树形结构
    const tagTree = computed(() => buildTree(tags.value));

    // ----- 弹窗状态 -----
    const editDialog = reactive({
      visible: false,
      mode: "create", // create | edit
      id: null,
      name: "",
      parentId: null,
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
    // 树勾选变化：保持"勾选顺序"
    const onTreeCheck = (data, checked) => {
      // data 是被点击的节点
      if (checked.checkedKeys.includes(data.id)) {
        if (!selectedTags.value.find((t) => t.id === data.id)) {
          selectedTags.value.push({ id: data.id, name: data.name });
        }
      } else {
        const i = selectedTags.value.findIndex((t) => t.id === data.id);
        if (i !== -1) selectedTags.value.splice(i, 1);
      }
    };
    const checkedKeys = computed(() => selectedTags.value.map((t) => t.id));
    const removeSelected = (id) => {
      const i = selectedTags.value.findIndex((t) => t.id === id);
      if (i !== -1) selectedTags.value.splice(i, 1);
      treeRef.value?.setChecked(id, false, false);
    };
    const moveSelected = (idx, delta) => {
      const arr = selectedTags.value;
      const j = idx + delta;
      if (j < 0 || j >= arr.length) return;
      [arr[idx], arr[j]] = [arr[j], arr[idx]];
    };
    const clearSelected = () => {
      selectedTags.value.forEach((t) => treeRef.value?.setChecked(t.id, false, false));
      selectedTags.value = [];
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
          const rest = m[2].trim();
          // 8位纯数字视为日期（文件行）
          if (/^\d{8}$/.test(bracketContent)) {
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
          ElMessage.success(data.msg || "导入成功");
          fileImportDialog.visible = false;
          await loadFiles();
          loadTagCloud();
        } else {
          ElMessage.error(data.msg || "导入失败");
        }
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
    const loadTagCloud = async () => {
      tagCloudLoading.value = true;
      try {
        const { data } = await http.get("/api/tags/stats");
        if (data.code === 0) {
          tagCloudData.value = data.data.filter((t) => t.count > 0);
        }
      } finally {
        tagCloudLoading.value = false;
      }
    };
    // 计算标签云位置（云朵形状分布）
    const tagCloudPositions = computed(() => {
      const data = tagCloudData.value;
      if (!data.length) return [];
      const counts = data.map((t) => t.count);
      const max = Math.max(...counts);
      const min = Math.min(...counts);
      const minSize = 13;
      const maxSize = 34;

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

      const positions = [];
      const placed = []; // 已放置的标签 {x, y, w, h}

      for (let i = 0; i < data.length; i++) {
        const tag = data[i];
        let size;
        if (max === min) {
          size = 18;
        } else {
          size = minSize + ((tag.count - min) / (max - min)) * (maxSize - minSize);
        }
        size = Math.round(size);

        // 估算标签宽高（字符数 * 字号）
        const estW = tag.name.length * size * 0.7 + 16;
        const estH = size * 1.5 + 8;

        // 在云朵区域内螺旋搜索放置位置
        let bestX = 0, bestY = 0, found = false;
        for (let attempt = 0; attempt < 200; attempt++) {
          // 螺旋 + 随机
          const angle = attempt * 0.618 * Math.PI * 2;
          const radius = 0.05 + attempt * 0.005;
          const jitterX = (seededRandom(i * 1000 + attempt * 7) - 0.5) * 0.15;
          const jitterY = (seededRandom(i * 2000 + attempt * 13) - 0.5) * 0.12;
          const nx = Math.cos(angle) * radius + jitterX;
          const ny = Math.sin(angle) * radius + jitterY;

          if (!isInCloud(nx, ny)) continue;

          // 转换为像素坐标 (容器 500x300)
          const px = 250 + nx * 220 - estW / 2;
          const py = 150 + ny * 130 - estH / 2;

          // 检查是否与已放置标签重叠
          let overlap = false;
          for (const p of placed) {
            if (px < p.x + p.w + 4 && px + estW + 4 > p.x &&
                py < p.y + p.h + 2 && py + estH + 2 > p.y) {
              overlap = true;
              break;
            }
          }
          if (!overlap) {
            bestX = px;
            bestY = py;
            found = true;
            break;
          }
        }

        if (!found) {
          // 如果未找到合适位置，随机放在边缘
          bestX = 250 + (seededRandom(i * 3000) - 0.5) * 350;
          bestY = 150 + (seededRandom(i * 4000) - 0.5) * 200;
        }

        placed.push({ x: bestX, y: bestY, w: estW, h: estH });

        const colors = ['#909399', '#67c23a', '#e6a23c', '#409eff', '#f56c6c', '#6f42c1'];
        const colorIdx = Math.min(Math.floor(((tag.count - min) / (max - min || 1)) * (colors.length - 1)), colors.length - 1);

        positions.push({
          ...tag,
          style: {
            position: 'absolute',
            left: bestX + 'px',
            top: bestY + 'px',
            fontSize: size + 'px',
            color: colors[colorIdx],
            cursor: 'pointer',
            padding: '3px 6px',
            lineHeight: '1.4',
            whiteSpace: 'nowrap',
            fontWeight: '500',
            borderRadius: '4px',
            transition: 'all 0.25s ease',
            userSelect: 'none',
          },
        });
      }
      return positions;
    });

    // ----- 文件列表 -----
    const fileList = ref([]);
    const fileQuery = reactive({
      keyword: "",
      tagIds: [],
      mode: "all", // all | any
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
      filePagination.page = 1;
      loadFiles();
    };
    const filterByTag = (tag) => {
      fileQuery.tagIds = [tag.id];
      fileQuery.mode = "all";
      filePagination.page = 1;
      loadFiles();
    };
    const selectedFiles = ref([]);
    const onSelectionChange = (rows) => {
      selectedFiles.value = rows;
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
      editDialog.title = parentId ? "新增子 Tag" : "新增 Tag";
      editDialog.visible = true;
    };

    const openEdit = (node) => {
      editDialog.mode = "edit";
      editDialog.id = node.id;
      editDialog.name = node.name;
      editDialog.parentId = node.parentId;
      editDialog.title = "编辑 Tag";
      editDialog.visible = true;
    };

    const submitEdit = async () => {
      const name = (editDialog.name || "").trim();
      if (!name) {
        ElMessage.warning("名称不能为空");
        return;
      }
      const payload = { name, parentId: editDialog.parentId || null };
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
      try {
        await ElMessageBox.confirm(
          `确定删除 "${node.name}"？其下所有子 Tag 也会一并删除。`,
          "确认删除",
          { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" }
        );
      } catch (_) { return; }
      const { data } = await http.delete(`/api/tags/${node.id}`);
      if (data.code === 0) {
        ElMessage.success("已删除");
        await loadTags();
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

    // 树过滤
    const filterNode = (value, data) => {
      if (!value) return true;
      return data.name.includes(value);
    };
    const onFilterChange = (v) => {
      treeRef.value?.filter(v);
    };

    onMounted(() => {
      loadTags();
      loadFiles();
      loadTagCloud();
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
      // 保存与文件列表
      saveLoading,
      saveFinal,
      fileImportDialog,
      fileImportParsed,
      openFileImport,
      handleFileImportUpload,
      submitFileImport,
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
      selectedFiles,
      onSelectionChange,
      batchDeleteFiles,
      removeFile,
      copyFileName,
      fileEditDialog,
      openFileEdit,
      submitFileEdit,
    };
  },
  template: `
    <div class="layout">
      <div class="topbar">
        <div class="title">🏷️ Tag 管理系统</div>
        <div class="right">
          <span style="color:#606266;">{{ username }}</span>
          <el-button size="small" @click="openPwd">修改账号/密码</el-button>
          <el-button size="small" type="danger" plain @click="logout">退出</el-button>
        </div>
      </div>

      <div class="main">
        <div class="toolbar">
          <el-button type="success" @click="openImport">📋 粘贴文本导入</el-button>
          <el-input
            v-model="filterText"
            placeholder="搜索 Tag 名称"
            clearable
            style="width:240px"
            @input="onFilterChange"
          />
          <span style="color:#909399;font-size:13px;">共 {{ tags.length }} 个 Tag</span>
          <span style="color:#c0c4cc;font-size:12px;margin-left:auto;">提示：点击标签名编辑，悬停显示 + / × 按钮</span>
        </div>

        <div class="split">
          <div class="tree-card">
            <div style="margin-bottom:10px;">
              <el-button size="small" type="primary" plain @click="openCreate(null)">+ 新建顶级 Tag</el-button>
            </div>
            <div v-if="!tags.length" class="empty-tip">暂无 Tag，点击上方按钮创建第一个吧</div>
            <el-tree
              v-else
              ref="treeRef"
              :data="tagTree"
              node-key="id"
              default-expand-all
              show-checkbox
              check-strictly
              :default-checked-keys="checkedKeys"
              :expand-on-click-node="false"
              :filter-node-method="filterNode"
              @check="onTreeCheck"
            >
              <template #default="{ node, data }">
                <div class="tag-node">
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
                    {{ data.name }}
                    <span class="tag-meta">#{{ data.id }}</span>
                  </span>
                </div>
              </template>
            </el-tree>
          </div>

          <div class="gen-card">
            <div class="gen-title">📝 文件名生成器</div>
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
                <div v-if="!selectedTags.length" class="empty-sub">在左侧勾选标签，可拖拽排序</div>
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

            <!-- 标签云 -->
            <div class="tag-cloud-section" v-loading="tagCloudLoading">
              <div class="tag-cloud-title">☁️ 标签云</div>
              <div v-if="!tagCloudData.length" style="color:#c0c4cc;font-size:13px;text-align:center;padding:20px 0;">暂无标签使用数据</div>
              <div v-else class="tag-cloud-container">
                <el-tooltip v-for="t in tagCloudPositions" :key="t.id" :content="t.name + '（' + t.count + ' 个文件）'" placement="top" :show-after="300">
                  <span
                    :style="t.style"
                    class="tag-cloud-item"
                    @click="filterByTag(t)"
                  >{{ t.name }}</span>
                </el-tooltip>
              </div>
            </div>
          </div>
        </div>

        <!-- 文件列表 -->
        <div class="files-card">
          <div class="files-header">
            <div class="files-title">📁 文件列表 <span class="files-count">共 {{ filePagination.total }} 个</span></div>
            <div class="files-actions">
              <el-button size="small" type="success" @click="openFileImport">导入</el-button>
              <el-button size="small" type="warning" @click="openExportDialog">导出</el-button>
            </div>
          </div>
          <div class="files-filter">
            <el-input
              v-model="fileQuery.keyword"
              placeholder="按文件名模糊搜索"
              clearable
              style="width:240px"
              @keyup.enter="loadFiles"
              @clear="loadFiles"
            />
            <el-tree-select
              v-model="fileQuery.tagIds"
              :data="tagTree"
              :props="{ value: 'id', label: 'name', children: 'children' }"
              node-key="id"
              multiple
              collapse-tags
              collapse-tags-tooltip
              check-strictly
              clearable
              placeholder="按标签筛选（可多选）"
              style="width:340px"
            />
            <el-radio-group v-model="fileQuery.mode" size="small">
              <el-radio-button label="all">同时包含 (AND)</el-radio-button>
              <el-radio-button label="any">任一包含 (OR)</el-radio-button>
            </el-radio-group>
            <el-button type="primary" @click="loadFiles">查询</el-button>
            <el-button @click="resetFileQuery">重置</el-button>
          </div>

          <div v-if="selectedFiles.length" style="margin-top:12px;margin-bottom:8px;display:flex;align-items:center;gap:10px;">
            <span style="color:#606266;font-size:13px;">已选 {{ selectedFiles.length }} 项</span>
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
                <span style="font-family:SFMono-Regular,Consolas,Menlo,monospace;word-break:break-all;">{{ row.name }}</span>
              </template>
            </el-table-column>
            <el-table-column label="标签" min-width="260">
              <template #default="{ row }">
                <div v-if="!row.tags.length" style="color:#c0c4cc;">-</div>
                <div v-else style="display:flex;flex-wrap:wrap;gap:4px;">
                  <el-tag v-for="t in row.tags" :key="t.id" size="small" type="info" style="cursor:pointer;" @click="filterByTag(t)">{{ t.name }}</el-tag>
                </div>
              </template>
            </el-table-column>
            <el-table-column prop="createdAt" label="保存时间" width="160" sortable />
            <el-table-column prop="updatedAt" label="更新时间" width="160" sortable />
            <el-table-column label="操作" width="220" fixed="right">
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
              :page-sizes="[10, 20, 50, 100]"
              layout="total, sizes, prev, pager, next, jumper"
              background
              @current-change="onPageChange"
              @size-change="onPageSizeChange"
            />
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
        </el-form>
        <template #footer>
          <el-button @click="editDialog.visible=false">取消</el-button>
          <el-button type="primary" @click="submitEdit">确定</el-button>
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
  // 清理空 children，element-plus 树要求 children 是数组或不存在
  const trim = (nodes) =>
    nodes.map((n) => {
      const o = { ...n };
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
