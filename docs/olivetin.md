On this computer, the active directory where OliveTin runs is `~/.local/opt/olivetin/` (or the absolute path `/Users/alper/.local/opt/olivetin/`).

### 1. Configuration File Location
You configure your OliveTin pages and buttons by editing the following file:
* **`/Users/alper/.local/opt/olivetin/config.yaml`**

---

### 2. How to Configure Actions
Actions are configured under the `actions:` block in `config.yaml`.

#### Simple Action
To add a simple button that runs a pre-defined command:
```yaml
actions:
  - title: "Restart Dev Server"
    icon: "restart"
    shell: "npm run dev:restart"
```
#### Action with Arguments (User Input)
To prompt the user for input before executing a command, define `arguments` and map them to variables inside `{{ ... }}` in your `shell` property:
```yaml
actions:
  - title: "Ping Host"
    icon: "ping"
    shell: "ping -c {{ count }} {{ host }}"
    arguments:
      - name: host
        title: "Target Host"
        type: ascii_identifier
        default: "example.com"
      - name: count
        title: "Ping Count"
        type: int
        default: 3
```
---

### 3. Applying Your Changes
After editing `/Users/alper/.local/opt/olivetin/config.yaml`, stop and restart OliveTin to load the new settings:
```bash
# Start OliveTin
olivetin
```