const messageForm = document.querySelector("#message-form");
const messageInput = document.querySelector("#message-input");
const messageResult = document.querySelector("#message-result");
const delayedContent = document.querySelector("#delayed-content");
const loadingStatus = document.querySelector("#loading-status");
const startDelay = document.querySelector("#start-delay");
const htmlDialog = document.querySelector("#html-dialog");
const dialogResult = document.querySelector("#dialog-result");
const dragSource = document.querySelector("#drag-source");
const dropTarget = document.querySelector("#drop-target");
const dragResult = document.querySelector("#drag-result");
const fileInput = document.querySelector("#file-input");
const fileResult = document.querySelector("#file-result");
const filePreview = document.querySelector("#file-preview");
const canvas = document.querySelector("#visual-canvas");
const canvasResult = document.querySelector("#canvas-result");
const viewportStatus = document.querySelector("#viewport-status");

let delayTimer;

function updateViewportStatus() {
  const layout = window.matchMedia("(max-width: 760px)").matches ? "single-column" : "two-column";
  viewportStatus.textContent = `Viewport ${window.innerWidth} x ${window.innerHeight}; ${layout}`;
}

function drawCanvas(active = false) {
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = active ? "#16834b" : "#1769d1";
  context.beginPath();
  context.arc(160, 70, 34, 0, Math.PI * 2);
  context.fill();
  context.fillStyle = "#fff";
  context.font = "600 18px system-ui";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(active ? "Done" : "Click", 160, 70);
}

function resetFixture() {
  clearTimeout(delayTimer);
  messageForm.reset();
  fileInput.value = "";
  messageResult.textContent = "No message submitted";
  loadingStatus.textContent = "Idle";
  delayedContent.hidden = true;
  dialogResult.textContent = "No dialog result";
  dragResult.textContent = "Nothing dropped";
  dropTarget.textContent = "Drop here";
  fileResult.textContent = "No file selected";
  filePreview.textContent = "";
  canvasResult.textContent = "Canvas untouched";
  drawCanvas(false);
}

messageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  messageResult.textContent = `Submitted: ${messageInput.value}`;
});

startDelay.addEventListener("click", () => {
  clearTimeout(delayTimer);
  delayedContent.hidden = true;
  loadingStatus.textContent = "Loading...";
  const configuredDelay = Number(new URLSearchParams(location.search).get("delay"));
  const delay = Number.isFinite(configuredDelay) && configuredDelay >= 0 ? configuredDelay : 700;
  delayTimer = setTimeout(() => {
    delayedContent.hidden = false;
    loadingStatus.textContent = "Loaded";
  }, delay);
});

document.querySelector("#open-html-dialog").addEventListener("click", () => htmlDialog.showModal());
document.querySelector("#close-html-dialog").addEventListener("click", () => {
  htmlDialog.close();
  dialogResult.textContent = "HTML dialog closed";
});
document.querySelector("#open-native-dialog").addEventListener("click", () => {
  const accepted = window.confirm("ControlMac native browser dialog");
  dialogResult.textContent = accepted ? "Browser dialog accepted" : "Browser dialog dismissed";
});

dragSource.addEventListener("dragstart", (event) => {
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", "controlmac-drag-payload");
});
dropTarget.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropTarget.classList.add("drag-over");
});
dropTarget.addEventListener("dragleave", () => dropTarget.classList.remove("drag-over"));
dropTarget.addEventListener("drop", (event) => {
  event.preventDefault();
  dropTarget.classList.remove("drag-over");
  const payload = event.dataTransfer.getData("text/plain");
  if (payload === "controlmac-drag-payload") {
    dropTarget.textContent = "Drop received";
    dragResult.textContent = "Drag completed";
  }
});

fileInput.addEventListener("change", async () => {
  const [file] = fileInput.files;
  if (!file) {
    fileResult.textContent = "No file selected";
    filePreview.textContent = "";
    return;
  }
  fileResult.textContent = `Selected file: ${file.name}`;
  filePreview.textContent = await file.text();
});

canvas.addEventListener("click", (event) => {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (event.clientX - rect.left) * scaleX;
  const y = (event.clientY - rect.top) * scaleY;
  const insideCircle = Math.hypot(x - 160, y - 70) <= 34;
  if (insideCircle) {
    canvasResult.textContent = "Canvas target activated";
    drawCanvas(true);
  } else {
    canvasResult.textContent = "Canvas missed";
  }
});

document.querySelector("#reset-fixture").addEventListener("click", resetFixture);
window.addEventListener("resize", updateViewportStatus);
updateViewportStatus();
resetFixture();
