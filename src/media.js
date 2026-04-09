const { v2: cloudinary } = require("cloudinary");

const { config } = require("./config");

const cloudinaryEnabled = Boolean(
  config.cloudinary.cloudName
    && config.cloudinary.apiKey
    && config.cloudinary.apiSecret,
);

if (cloudinaryEnabled) {
  cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
    secure: true,
  });
}

function isRemoteAssetUrl(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function isCloudinaryUrl(value) {
  const text = String(value || "").trim();
  if (!text || !cloudinaryEnabled) {
    return false;
  }
  return text.includes(`/res.cloudinary.com/${config.cloudinary.cloudName}/`);
}

function extractPublicIdFromCloudinaryUrl(value) {
  if (!isCloudinaryUrl(value)) {
    return null;
  }

  try {
    const parsed = new URL(value);
    const parts = parsed.pathname.split("/").filter(Boolean);
    // /<cloudName>/image/upload/v123/folder/file.jpg
    const uploadIndex = parts.findIndex((part) => part === "upload");
    if (uploadIndex === -1) {
      return null;
    }

    let publicParts = parts.slice(uploadIndex + 1);
    if (publicParts[0] && /^v\d+$/i.test(publicParts[0])) {
      publicParts = publicParts.slice(1);
    }

    if (!publicParts.length) {
      return null;
    }

    const last = publicParts[publicParts.length - 1];
    publicParts[publicParts.length - 1] = last.replace(/\.[a-z0-9]+$/i, "");
    return publicParts.join("/");
  } catch (error) {
    return null;
  }
}

async function uploadImageFromPath(localPath, { folder = null } = {}) {
  if (!cloudinaryEnabled) {
    throw new Error("Cloudinary não configurado.");
  }

  const result = await cloudinary.uploader.upload(localPath, {
    resource_type: "image",
    folder: folder || config.cloudinary.folder || undefined,
    overwrite: false,
  });

  return {
    secureUrl: result.secure_url,
    publicId: result.public_id,
  };
}

async function deleteImageByUrl(value) {
  if (!cloudinaryEnabled) {
    return false;
  }

  const publicId = extractPublicIdFromCloudinaryUrl(value);
  if (!publicId) {
    return false;
  }

  await cloudinary.uploader.destroy(publicId, {
    resource_type: "image",
    invalidate: true,
  });
  return true;
}

module.exports = {
  isCloudinaryEnabled: () => cloudinaryEnabled,
  isRemoteAssetUrl,
  uploadImageFromPath,
  deleteImageByUrl,
};
