# Change Log

## 0.11.0

- Enhance SdsioServerLauncher and SdsIOInterfaceProvider for graceful shutdown and terminal management
- Update SDS-Framework version and fix formatting in download-tools script
- Refactor SDS interface: combine explorer and flags functionality, update
- Update extension display name and improve diagnostic output formatting
- Improve/handle sds filename labels by
- Switch to antd charts for dataViewer and audioViewer
- Enhance media viewers with file statistics and improve UI elements
- Fix/load sds with labels
- Feature/add sds schema validation completion
- Refactor SdsioServerLauncher to static method and update terminal
- Refactor SDS commands and UI for improved consistency and clarity
- Fix getIndexedSdsSuffix to return correct match group for SDS file suffix
- Feature/sds check command action on sds files
- Fix default terminal profile resolution for PowerShell in SdsioServerLauncher
- Add commands to open group metadata and close config in SDS
- Enhance AudioViewer and DataViewerApp to track current block index
- Fix/time to cursor resolution

## 0.9.0

- First public release of the extension.
- Improve/reactify component.
  - Synchronize Data Views with Media Viewers (video, image, audio) 
  - Add a new Audio Media Viewer
  - Include sdsio-server component
  - Add Server UI Controlls to sdsio-server (Record/Playback/Stop, Flags)
- Fix package name and publisher in package.json.
- Remove transparent background of PNG icon.
- Update extension icon to use new Arm marketplace image.
- Update SDS file handling to support optional '.p' suffix in regex patterns.

## 0.8.1.34

- Initial private release of extension pack on GitHub.
