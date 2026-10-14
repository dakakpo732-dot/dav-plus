
/* ======================================================
   DAV+ — APPLICATION DE MESSAGERIE
   Remplace les deux valeurs ci-dessous avec celles
   de ton propre projet Supabase.
   Utilise la clé Publishable ou l'ancienne clé anon.
   Ne mets JAMAIS la clé service_role ici.
====================================================== */

const SUPABASE_URL = "https://njgjhpxbfmzmkntbbygg.supabase.co";
const SUPABASE_KEY = "sb_publishable__A4BfEBQC2kdVi8BGPVHWg_NSoKicZB";

let db = null;
let currentUser = null;
let currentProfile = null;
let activeConversation = null;
let conversations = [];
let authMode = "login";
let messageChannel = null;
let groupMembers = new Set();
let toastTimer = null;
let searchTimer = null;
let groupSearchTimer = null;

const $ = (id) => document.getElementById(id);

function showToast(message, type = "success") {
  const toast = $("toast");
  toast.textContent = message;
  toast.className = `toast ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), 4500);
}

function showError(error, fallback = "Une erreur est survenue.") {
  console.error(error);
  showToast(error?.message || fallback, "error");
}

function setBusy(button, busy, label = "Chargement...") {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
  }
}

function initials(name) {
  const words = (name || "D").trim().split(/\s+/).filter(Boolean);
  return words.slice(0, 2).map(word => word[0]).join("").toUpperCase() || "D";
}

function makeAvatar(name, extraClass = "") {
  const avatar = document.createElement("div");
  avatar.className = `avatar ${extraClass}`.trim();
  avatar.textContent = initials(name);
  return avatar;
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("fr-FR", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return "Aujourd'hui";
  if (date.toDateString() === yesterday.toDateString()) return "Hier";

  return new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit",
    month: "short"
  }).format(date);
}

function showAuth() {
  $("authScreen").classList.remove("hidden");
  $("appScreen").classList.add("hidden");
}

function showApp() {
  $("authScreen").classList.add("hidden");
  $("appScreen").classList.remove("hidden");
}

function setAuthMode(mode) {
  authMode = mode;
  const signup = mode === "signup";

  $("authTitle").textContent = signup ? "Rejoins DAV+" : "Bienvenue sur DAV+";
  $("authDescription").textContent = signup
    ? "Crée ton compte pour commencer à discuter."
    : "Connecte-toi pour retrouver tes conversations.";
  $("nameField").classList.toggle("hidden", !signup);
  $("displayName").required = signup;
  $("authSubmit").textContent = signup ? "Créer mon compte" : "Se connecter";
  $("switchText").textContent = signup
    ? "Tu as déjà un compte ?"
    : "Tu n'as pas encore de compte ?";
  $("switchAuth").textContent = signup ? "Se connecter" : "Créer un compte";
  $("password").autocomplete = signup ? "new-password" : "current-password";
}

async function handleAuth(event) {
  event.preventDefault();

  if (!db) {
    showToast("Configure d'abord l'URL et la clé Supabase dans script.js.", "error");
    return;
  }

  const button = $("authSubmit");
  const email = $("email").value.trim();
  const password = $("password").value;
  const displayName = $("displayName").value.trim();

  setBusy(button, true);

  try {
    if (authMode === "signup") {
      if (displayName.length < 1 || displayName.length > 60) {
        throw new Error("Ton nom doit contenir entre 1 et 60 caractères.");
      }

      const { data, error } = await db.auth.signUp({
        email,
        password,
        options: {
          data: { display_name: displayName }
        }
      });

      if (error) throw error;

      if (data.session) {
        await startApp(data.session.user);
        showToast("Bienvenue sur DAV+ !");
      } else {
        showToast(
          "Compte créé. Vérifie ta boîte e-mail pour confirmer ton inscription."
        );
      }
    } else {
      const { data, error } = await db.auth.signInWithPassword({
        email,
        password
      });

      if (error) throw error;

      await startApp(data.user);
      showToast("Connexion réussie !");
    }
  } catch (error) {
    showError(error, "Impossible de continuer. Vérifie tes informations.");
  } finally {
    setBusy(button, false);
  }
}

async function handleLogout() {
  if (!db) return;

  const { error } = await db.auth.signOut();
  if (error) {
    showError(error, "Impossible de se déconnecter.");
    return;
  }

  if (messageChannel) {
    await db.removeChannel(messageChannel);
    messageChannel = null;
  }

  currentUser = null;
  currentProfile = null;
  activeConversation = null;
  conversations = [];
  showAuth();
}

async function startApp(user) {
  currentUser = user;
  activeConversation = null;

  if (messageChannel) {
    await db.removeChannel(messageChannel);
    messageChannel = null;
  }

  showApp();
  await loadProfile();
  await loadConversations();
}

async function loadProfile() {
  const { data, error } = await db
    .from("profiles")
    .select("id, display_name, avatar_url, created_at")
    .eq("id", currentUser.id)
    .maybeSingle();

  if (error) throw error;

  const metadataName = currentUser.user_metadata?.display_name;
  currentProfile = data || {
    id: currentUser.id,
    display_name: metadataName || "Utilisateur",
    avatar_url: null
  };

  $("myName").textContent = currentProfile.display_name;
  $("myAvatar").textContent = initials(currentProfile.display_name);
}

async function saveProfile(event) {
  event.preventDefault();

  const name = $("profileName").value.trim();
  if (!name || name.length > 60) {
    showToast("Choisis un nom entre 1 et 60 caractères.", "error");
    return;
  }

  const button = event.submitter;
  setBusy(button, true);

  try {
    const { data, error } = await db
      .from("profiles")
      .update({ display_name: name })
      .eq("id", currentUser.id)
      .select()
      .single();

    if (error) throw error;

    currentProfile = data;
    $("myName").textContent = data.display_name;
    $("myAvatar").textContent = initials(data.display_name);
    $("profileDialog").close();
    await loadConversations();
    showToast("Profil mis à jour.");
  } catch (error) {
    showError(error, "Impossible de modifier le profil.");
  } finally {
    setBusy(button, false);
  }
}

async function loadConversations() {
  const list = $("conversationList");
  list.replaceChildren();

  const { data: memberships, error: memberError } = await db
    .from("conversation_members")
    .select("conversation_id")
    .eq("user_id", currentUser.id);

  if (memberError) throw memberError;

  const ids = [...new Set((memberships || []).map(item => item.conversation_id))];

  if (!ids.length) {
    conversations = [];
    $("conversationCount").textContent = "0";
    renderConversationList();
    return;
  }

  const { data: rows, error: conversationError } = await db
    .from("conversations")
    .select("id, kind, title, created_by, created_at")
    .in("id", ids)
    .order("created_at", { ascending: false });

  if (conversationError) throw conversationError;

  const { data: allMemberships, error: allMembersError } = await db
    .from("conversation_members")
    .select("conversation_id, user_id")
    .in("conversation_id", ids);

  if (allMembersError) throw allMembersError;

  const userIds = [...new Set((allMemberships || []).map(m => m.user_id))];

  const { data: profiles, error: profilesError } = await db
    .from("profiles")
    .select("id, display_name, avatar_url")
    .in("id", userIds);

  if (profilesError) throw profilesError;

  const profileMap = new Map((profiles || []).map(p => [p.id, p]));

  const { data: recentMessages, error: messagesError } = await db
    .from("messages")
    .select("conversation_id, body, sender_id, created_at")
    .in("conversation_id", ids)
    .order("created_at", { ascending: false })
    .limit(500);

  if (messagesError) throw messagesError;

  const latestByConversation = new Map();
  for (const message of recentMessages || []) {
    if (!latestByConversation.has(message.conversation_id)) {
      latestByConversation.set(message.conversation_id, message);
    }
  }

  conversations = (rows || []).map(conversation => {
    const members = (allMemberships || [])
      .filter(m => m.conversation_id === conversation.id)
      .map(m => ({
        id: m.user_id,
        name: profileMap.get(m.user_id)?.display_name || "Utilisateur"
      }));

    const otherMember = members.find(m => m.id !== currentUser.id);
    const title = conversation.kind === "group"
      ? conversation.title
      : (otherMember?.name || "Conversation privée");

    return {
      ...conversation,
      members,
      title,
      lastMessage: latestByConversation.get(conversation.id) || null
    };
  });

  conversations.sort((a, b) => {
    const aTime = a.lastMessage?.created_at || a.created_at;
    const bTime = b.lastMessage?.created_at || b.created_at;
    return new Date(bTime) - new Date(aTime);
  });

  renderConversationList();
}

function renderConversationList() {
  const list = $("conversationList");
  const query = $("conversationSearch").value.trim().toLowerCase();

  list.replaceChildren();

  const filtered = conversations.filter(c => {
    const preview = c.lastMessage?.body || "";
    return `${c.title} ${preview}`.toLowerCase().includes(query);
  });

  $("conversationCount").textContent = String(conversations.length);

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = conversations.length
      ? "Aucune discussion ne correspond à ta recherche."
      : "Pas encore de discussion. Clique sur « Nouvelle discussion » pour commencer.";
    list.append(empty);
    return;
  }

  for (const conversation of filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "conversation-item";
    if (activeConversation?.id === conversation.id) {
      button.classList.add("active");
    }

    const avatarName = conversation.kind === "group"
      ? conversation.title
      : conversation.members.find(m => m.id !== currentUser.id)?.name;

    button.append(makeAvatar(avatarName || conversation.title));

    const meta = document.createElement("div");
    meta.className = "conversation-meta";

    const title = document.createElement("strong");
    title.textContent = conversation.title;

    const preview = document.createElement("span");
    preview.textContent = conversation.lastMessage
      ? `${conversation.lastMessage.sender_id === currentUser.id ? "Toi : " : ""}${conversation.lastMessage.body}`
      : (conversation.kind === "group" ? "Groupe DAV+" : "Commence la conversation");

    meta.append(title, preview);
    button.append(meta);

    if (conversation.lastMessage) {
      const time = document.createElement("span");
      time.className = "muted";
      time.textContent = formatTime(conversation.lastMessage.created_at);
      button.append(time);
    }

    button.addEventListener("click", () => openConversation(conversation.id));
    list.append(button);
  }
}

async function openConversation(conversationId) {
  const conversation = conversations.find(c => c.id === conversationId);
  if (!conversation) return;

  activeConversation = conversation;
  $("welcomePanel").classList.add("hidden");
  $("chatView").classList.remove("hidden");
  $("appScreen").classList.add("chat-open");

  $("chatTitle").textContent = conversation.title;
  $("chatSubtitle").textContent = conversation.kind === "group"
    ? `${conversation.members.length} membre(s) · Groupe DAV+`
    : "Conversation privée DAV+";

  $("chatAvatar").textContent = initials(conversation.title);
  renderConversationList();

  const list = $("messageList");
  list.replaceChildren();
  const loading = document.createElement("div");
  loading.className = "empty-list";
  loading.textContent = "Chargement des messages...";
  list.append(loading);

  await loadMessages(conversationId);
  subscribeToMessages(conversationId);
  $("messageInput").focus();
}

async function loadMessages(conversationId) {
  const { data, error } = await db
    .from("messages")
    .select("id, conversation_id, sender_id, body, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(200);

  if (error) {
    showError(error, "Impossible de charger les messages.");
    return;
  }

  if (activeConversation?.id !== conversationId) return;

  renderMessages(data || []);
}

function renderMessages(messages) {
  const list = $("messageList");
  list.replaceChildren();

  if (!messages.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "Aucun message pour le moment. Envoie le premier !";
    list.append(empty);
    return;
  }

  let previousDay = "";

  for (const message of messages) {
    const day = new Date(message.created_at).toDateString();

    if (day !== previousDay) {
      const dayLabel = document.createElement("div");
      dayLabel.className = "message-day";
      dayLabel.textContent = formatDate(message.created_at);
      list.append(dayLabel);
      previousDay = day;
    }

    const mine = message.sender_id === currentUser.id;
    const row = document.createElement("div");
    row.className = `message-row${mine ? " mine" : ""}`;

    if (!mine && activeConversation?.kind === "group") {
      const member = activeConversation.members.find(m => m.id === message.sender_id);
      const sender = document.createElement("span");
      sender.className = "message-sender";
      sender.textContent = member?.name || "Membre";
      row.append(sender);
    }

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";
    bubble.textContent = message.body;

    const time = document.createElement("span");
    time.className = "message-time";
    time.textContent = formatTime(message.created_at);

    row.append(bubble, time);
    list.append(row);
  }

  list.scrollTop = list.scrollHeight;
}

function subscribeToMessages(conversationId) {
  if (messageChannel) {
    db.removeChannel(messageChannel);
    messageChannel = null;
  }

  messageChannel = db
    .channel(`dav-messages-${conversationId}`)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `conversation_id=eq.${conversationId}`
      },
      async payload => {
        if (activeConversation?.id !== conversationId) return;

        const list = $("messageList");
        const empty = list.querySelector(".empty-list");
        if (empty) empty.remove();

        const { data, error } = await db
          .from("messages")
          .select("id, conversation_id, sender_id, body, created_at")
          .eq("conversation_id", conversationId)
          .order("created_at", { ascending: true })
          .limit(200);

        if (!error && data) renderMessages(data);

        loadConversations().catch(error =>
          console.error("Actualisation des discussions :", error)
        );
      }
    )
    .subscribe(status => {
      if (status === "CHANNEL_ERROR") {
        console.warn("La connexion temps réel a rencontré une erreur.");
      }
    });
}

async function sendMessage(event) {
  event.preventDefault();

  if (!activeConversation) {
    showToast("Choisis d'abord une discussion.", "error");
    return;
  }

  const input = $("messageInput");
  const body = input.value.trim();

  if (!body) return;

  const button = $("sendBtn");
  button.disabled = true;

  try {
    const { error } = await db.from("messages").insert({
      conversation_id: activeConversation.id,
      sender_id: currentUser.id,
      body
    });

    if (error) throw error;

    input.value = "";
    input.style.height = "auto";

    // Rechargement de secours si l'événement temps réel tarde.
    await loadMessages(activeConversation.id);
    await loadConversations();
  } catch (error) {
    showError(error, "Message non envoyé.");
  } finally {
    button.disabled = false;
    input.focus();
  }
}

async function searchUsers(query, target, excludeIds = []) {
  target.replaceChildren();

  if (query.trim().length < 2) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Saisis au moins deux caractères.";
    target.append(note);
    return;
  }

  const { data, error } = await db
    .from("profiles")
    .select("id, display_name, avatar_url")
    .ilike("display_name", `%${query.trim()}%`)
    .neq("id", currentUser.id)
    .limit(20);

  if (error) {
    showError(error, "Impossible de rechercher les utilisateurs.");
    return;
  }

  const users = (data || []).filter(user => !excludeIds.includes(user.id));

  if (!users.length) {
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "Aucun utilisateur trouvé. Il doit avoir créé un compte DAV+.";
    target.append(note);
    return;
  }

  for (const user of users) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "user-result";
    row.append(makeAvatar(user.display_name));

    const info = document.createElement("div");
    info.className = "result-info";

    const name = document.createElement("strong");
    name.textContent = user.display_name;

    const subtitle = document.createElement("span");
    subtitle.textContent = "Utilisateur DAV+";

    info.append(name, subtitle);
    row.append(info);

    if (target.id === "groupUserResults") {
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = groupMembers.has(user.id);
      checkbox.setAttribute("aria-label", `Ajouter ${user.display_name}`);

      checkbox.addEventListener("click", event => event.stopPropagation());
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) groupMembers.add(user.id);
        else groupMembers.delete(user.id);
        updateSelectedCount();
      });

      row.append(checkbox);
      row.addEventListener("click", event => {
        if (event.target === checkbox) return;
        checkbox.checked = !checkbox.checked;
        checkbox.dispatchEvent(new Event("change"));
      });
    } else {
      row.addEventListener("click", () => startDirectChat(user.id));
    }

    target.append(row);
  }
}

async function startDirectChat(otherUserId) {
  try {
    const { data, error } = await db.rpc("create_direct_conversation", {
      p_other_user: otherUserId
    });

    if (error) throw error;

    $("userDialog").close();
    $("userSearchInput").value = "";

    await loadConversations();
    await openConversation(data);
  } catch (error) {
    showError(error, "Impossible de créer la discussion.");
  }
}

function updateSelectedCount() {
  const count = groupMembers.size;
  $("selectedCount").textContent =
    `${count} participant${count > 1 ? "s" : ""} sélectionné${count > 1 ? "s" : ""}`;
}

async function createGroup(event) {
  event.preventDefault();

  const title = $("groupName").value.trim();

  if (!title || title.length > 100) {
    showToast("Le nom du groupe doit contenir entre 1 et 100 caractères.", "error");
    return;
  }

  if (!groupMembers.size) {
    showToast("Choisis au moins un autre participant.", "error");
    return;
  }

  const button = event.submitter;
  setBusy(button, true, "Création...");

  try {
    const { data, error } = await db.rpc("create_group_conversation", {
      p_title: title,
      p_member_ids: [...groupMembers]
    });

    if (error) throw error;

    $("groupDialog").close();
    $("groupForm").reset();
    groupMembers.clear();
    updateSelectedCount();

    await loadConversations();
    await openConversation(data);
    showToast("Groupe créé !");
  } catch (error) {
    showError(error, "Impossible de créer le groupe.");
  } finally {
    setBusy(button, false);
  }
}

function setupMobileBackButton() {
  const header = document.querySelector(".chat-header");
  if (!header || header.querySelector(".back-to-chats")) return;

  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn back-to-chats";
  button.textContent = "←";
  button.setAttribute("aria-label", "Retour aux discussions");
  button.addEventListener("click", () => {
    $("appScreen").classList.remove("chat-open");
  });

  header.prepend(button);
}

function setupDialogs() {
  $("newChatBtn").addEventListener("click", () => {
    $("userDialog").showModal();
    $("userSearchInput").focus();
  });

  $("welcomeNewChat").addEventListener("click", () => {
    $("userDialog").showModal();
    $("userSearchInput").focus();
  });

  $("newGroupBtn").addEventListener("click", () => {
    groupMembers.clear();
    $("groupForm").reset();
    updateSelectedCount();
    $("groupUserResults").replaceChildren();
    $("groupDialog").showModal();
  });

  document.querySelectorAll(".close-dialog").forEach(button => {
    button.addEventListener("click", () => button.closest("dialog").close());
  });

  for (const dialog of document.querySelectorAll("dialog")) {
    dialog.addEventListener("click", event => {
      if (event.target === dialog) dialog.close();
    });
  }

  $("userSearchInput").addEventListener("input", event => {
    clearTimeout(searchTimer);
    const query = event.target.value;
    searchTimer = setTimeout(() => {
      searchUsers(query, $("userResults")).catch(showError);
    }, 250);
  });

  $("groupSearch").addEventListener("input", event => {
    clearTimeout(groupSearchTimer);
    const query = event.target.value;
    groupSearchTimer = setTimeout(() => {
      searchUsers(query, $("groupUserResults"), []).catch(showError);
    }, 250);
  });
}

function setupAppEvents() {
  $("authForm").addEventListener("submit", handleAuth);
  $("switchAuth").addEventListener("click", () => {
    setAuthMode(authMode === "login" ? "signup" : "login");
  });

  $("logoutBtn").addEventListener("click", handleLogout);
  $("messageForm").addEventListener("submit", sendMessage);
  $("profileForm").addEventListener("submit", saveProfile);
  $("groupForm").addEventListener("submit", createGroup);

  $("editProfileBtn").addEventListener("click", () => {
    $("profileName").value = currentProfile?.display_name || "";
    $("profileDialog").showModal();
  });

  $("conversationSearch").addEventListener("input", renderConversationList);

  $("messageInput").addEventListener("input", event => {
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 130)}px`;
  });

  $("messageInput").addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("messageForm").requestSubmit();
    }
  });

  setupDialogs();
  setupMobileBackButton();
}

async function initializeDAV() {
  setAuthMode("login");
  setupAppEvents();

  if (
    SUPABASE_URL.includes("COLLE_ICI") ||
    SUPABASE_KEY.includes("COLLE_ICI") ||
    !SUPABASE_URL.startsWith("https://") ||
    !SUPABASE_KEY
  ) {
    showAuth();
    showToast("Ajoute l'URL et la clé publique Supabase dans script.js.", "error");
    return;
  }

  if (!window.supabase?.createClient) {
    showAuth();
    showToast("La bibliothèque Supabase n'a pas pu se charger. Vérifie Internet.", "error");
    return;
  }

  db = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  db.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      currentUser = null;
      currentProfile = null;
      showAuth();
    }
  });

  try {
    const { data, error } = await db.auth.getSession();
    if (error) throw error;

    if (data.session?.user) {
      await startApp(data.session.user);
    } else {
      showAuth();
    }
  } catch (error) {
    showAuth();
    showError(error, "Impossible de vérifier la connexion.");
  }
}

document.addEventListener("DOMContentLoaded", initializeDAV);
