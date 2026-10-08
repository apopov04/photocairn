# Third-party components

Photocairn bundles the following so it can run fully offline, with no requests to other servers.

## ONNX Runtime Web (`vendor/ort/`)
- Version 1.30.0, from https://github.com/microsoft/onnxruntime
- MIT License, © Microsoft Corporation. See `vendor/ort/LICENSE`.

## ag-psd (`vendor/ag-psd/`)
- Version 31.0.3, from https://github.com/Agamnentzar/ag-psd
- MIT License. See `vendor/ag-psd/LICENSE`. Used for opening and saving Photoshop files. It is loaded only when a PSD is opened or saved.

## U²-Net background-removal models (`models/`)
- `u2netp.onnx` ("Fast") is the small U²-Net model by Xuebin Qin et al.: https://github.com/xuebinqin/U-2-Net (Apache License 2.0).
- `silueta.onnx.part*` ("Best quality") is a compact U²-Net variant distributed by the rembg project: https://github.com/danielgatis/rembg (MIT License). It is split into two files so each stays under static-hosting size limits; the app joins them in the browser.
- The ONNX exports come from the rembg project's releases.

> Qin, X., Zhang, Z., Huang, C., Dehghan, M., Zaiane, O. R., & Jagersand, M. (2020). *U²-Net: Going deeper with nested U-structure for salient object detection.* Pattern Recognition, 106, 107404.
