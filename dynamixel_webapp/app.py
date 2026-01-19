import atexit
import time
from threading import Lock
from flask import Flask, render_template, send_from_directory
from flask_socketio import SocketIO, emit
from serial.tools import list_ports
from dynamixel_sdk import PortHandler, PacketHandler, COMM_SUCCESS
from config import TELEMETRY_DT, DEFAULT_BAUDRATE, SCAN_ID_MIN, SCAN_ID_MAX
from dynamixel_controller import DynamixelController, DynamixelError

# Flask setup
app = Flask(
    __name__,
    static_folder="frontend/static",
    template_folder="frontend",
)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

# Dynamixel controller 
dxl = None
dxl_lock = Lock()
connection_info = {
    "port": None,
    "baudrate": None,
    "ids": [],
}
dxl_error_message = None

telemetry_thread = None
telemetry_thread_lock = Lock()
running = True


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/static/<path:path>")
def static_proxy(path):
    return send_from_directory("frontend/static", path)


# Telemetry logging

def telemetry_loop():
    global running
    while running:
        timestamp = time.time()
        with dxl_lock:
            controller = dxl
        if controller is not None:
            data = controller.read_all_states()
        else:
            data = {}
        socketio.emit("telemetry", {"timestamp": timestamp, "servos": data})
        socketio.sleep(TELEMETRY_DT)


def ensure_telemetry_thread():
    global telemetry_thread
    with telemetry_thread_lock:
        if telemetry_thread is None:
            telemetry_thread = socketio.start_background_task(telemetry_loop)


def get_serial_ports():
    ports = []
    for p in list_ports.comports():
        ports.append(
            {
                "device": p.device,
                "description": p.description,
            }
        )
    return ports


def connect_controller(port: str, baudrate: int, ids):
    global dxl, dxl_error_message, connection_info
    ids = [int(i) for i in ids]
    with dxl_lock:
        # Close previous controller if any
        if dxl is not None:
            try:
                dxl.close()
            except Exception:
                pass
            dxl = None
        try:
            controller = DynamixelController(ids=ids, port=port, baudrate=baudrate)
            dxl = controller
            connection_info = {
                "port": port,
                "baudrate": baudrate,
                "ids": ids,
            }
            dxl_error_message = None
            print(f"[INFO] Connected to DXL on {port} @ {baudrate}, IDs={ids}")
            return True, "Connected successfully."
        except Exception as e:
            dxl = None
            dxl_error_message = str(e)
            print(f"[ERROR] Failed to connect: {e}")
            return False, f"Failed to connect: {e}"


def disconnect_controller():
    global dxl, connection_info
    with dxl_lock:
        if dxl is not None:
            try:
                dxl.close()
            except Exception:
                pass
            dxl = None
        connection_info = {"port": None, "baudrate": None, "ids": []}
    print("[INFO] Disconnected from DXL")


# Socket.IO (DO NOT CHANGE ANYTHING HERE!)

@socketio.on("connect")
def handle_connect():
    print("[INFO] Client connected")
    ensure_telemetry_thread()
    emit("serial_ports", {"ports": get_serial_ports()})
    emit(
        "connect_result",
        {
            "ok": dxl is not None,
            "message": "Connected" if dxl is not None else "Not connected",
            "connected": dxl is not None,
            "info": connection_info,
        },
    )
    if dxl_error_message:
        emit("backend_error", {"message": dxl_error_message})


@socketio.on("disconnect")
def handle_disconnect():
    print("[INFO] Client disconnected")


@socketio.on("list_serial_ports")
def handle_list_serial_ports():
    emit("serial_ports", {"ports": get_serial_ports()})


@socketio.on("scan_servos")
def handle_scan_servos(message):
    port = message.get("port")
    if not port:
        emit("scan_result", {"ok": False, "message": "No port specified.", "ids": []})
        return

    try:
        baudrate = int(message.get("baudrate") or DEFAULT_BAUDRATE)
    except (TypeError, ValueError):
        baudrate = DEFAULT_BAUDRATE

    try:
        id_min = int(message.get("idMin") or SCAN_ID_MIN)
        id_max = int(message.get("idMax") or SCAN_ID_MAX)
    except (TypeError, ValueError):
        id_min, id_max = SCAN_ID_MIN, SCAN_ID_MAX

    if id_min > id_max:
        id_min, id_max = id_max, id_min

    found_ids = []
    port_handler = PortHandler(port)
    packet_handler = PacketHandler(2.0)

    try:
        if not port_handler.openPort():
            emit(
                "scan_result",
                {"ok": False, "message": f"Failed to open port {port}", "ids": []},
            )
            return

        if not port_handler.setBaudRate(baudrate):
            emit(
                "scan_result",
                {"ok": False, "message": f"Failed to set baudrate {baudrate}", "ids": []},
            )
            return

        for dxl_id in range(id_min, id_max + 1):
            try:
                model_number, dxl_comm_result, dxl_error = packet_handler.ping(
                    port_handler, dxl_id
                )
                if dxl_comm_result == COMM_SUCCESS and dxl_error == 0:
                    found_ids.append(int(dxl_id))
            except Exception:
                continue

        msg = (
            f"Found IDs: {found_ids}"
            if found_ids
            else f"No servos responded on {port} @ {baudrate} in range {id_min}-{id_max}."
        )
        emit(
            "scan_result",
            {
                "ok": True,
                "message": msg,
                "ids": found_ids,
                "port": port,
                "baudrate": baudrate,
                "idMin": id_min,
                "idMax": id_max,
            },
        )
    finally:
        try:
            port_handler.closePort()
        except Exception:
            pass


@socketio.on("connect_servos")
def handle_connect_servos(message):
    port = message.get("port")
    ids = message.get("ids") or []

    if not port:
        emit(
            "connect_result",
            {
                "ok": False,
                "message": "No port specified.",
                "connected": False,
                "info": connection_info,
            },
        )
        return
    if not ids:
        emit(
            "connect_result",
            {
                "ok": False,
                "message": "No servo IDs selected.",
                "connected": False,
                "info": connection_info,
            },
        )
        return

    try:
        baudrate = int(message.get("baudrate") or DEFAULT_BAUDRATE)
    except (TypeError, ValueError):
        baudrate = DEFAULT_BAUDRATE

    ok, msg = connect_controller(port, baudrate, ids)
    emit(
        "connect_result",
        {
            "ok": ok,
            "message": msg,
            "connected": ok,
            "info": connection_info,
        },
    )
    if not ok:
        emit("backend_error", {"message": msg})


@socketio.on("disconnect_servos")
def handle_disconnect_servos():
    disconnect_controller()
    emit(
        "connect_result",
        {
            "ok": True,
            "message": "Disconnected from Dynamixel bus.",
            "connected": False,
            "info": connection_info,
        },
    )


@socketio.on("set_operating_mode")
def handle_set_operating_mode(message):
    global dxl
    with dxl_lock:
        controller = dxl

    if controller is None:
        emit("backend_error", {"message": "Not connected to any Dynamixel bus."})
        return

    dxl_id = int(message.get("id"))
    mode = int(message.get("mode"))
    auto_torque = bool(message.get("autoTorque", True))

    try:
        controller.set_operating_mode(dxl_id, mode, auto_torque=auto_torque)
        emit("log", {"level": "info", "message": f"ID {dxl_id}: set operating mode to {mode}"})
    except (ValueError, DynamixelError) as e:
        emit("log", {"level": "error", "message": f"Failed to set operating mode on ID {dxl_id}: {e}"})


@socketio.on("set_torque")
def handle_set_torque(message):
    global dxl
    with dxl_lock:
        controller = dxl

    if controller is None:
        emit("backend_error", {"message": "Not connected to any Dynamixel bus."})
        return

    dxl_id = int(message.get("id"))
    enable = bool(message.get("enable"))

    try:
        controller.set_torque(dxl_id, enable)
        emit("log", {"level": "info", "message": f"ID {dxl_id}: torque {'ON' if enable else 'OFF'}"})
    except DynamixelError as e:
        emit("log", {"level": "error", "message": f"Failed to set torque on ID {dxl_id}: {e}"})


@socketio.on("set_pid")
def handle_set_pid(message):
    global dxl
    with dxl_lock:
        controller = dxl

    if controller is None:
        emit("backend_error", {"message": "Not connected to any Dynamixel bus."})
        return

    dxl_id = int(message.get("id"))

    p_p = int(message.get("P", 0))
    p_i = int(message.get("I", 0))
    p_d = int(message.get("D", 0))
    v_p = int(message.get("velocityP", 0))
    v_i = int(message.get("velocityI", 0))

    try:
        controller.set_position_pid_gains(dxl_id, p_p, p_i, p_d)
        controller.set_velocity_pi_gains(dxl_id, v_p, v_i)
        emit("log", {"level": "info", "message": f"ID {dxl_id}: updated PID gains"})
    except DynamixelError as e:
        emit("log", {"level": "error", "message": f"Failed to set PID gains on ID {dxl_id}: {e}"})


@socketio.on("set_goals")
def handle_set_goals(message):
    global dxl
    with dxl_lock:
        controller = dxl

    if controller is None:
        emit("backend_error", {"message": "Not connected to any Dynamixel bus."})
        return

    dxl_id = int(message.get("id"))

    def maybe_int(key):
        value = message.get(key)
        if value is None or value == "" or value is False:
            return None
        return int(value)

    kwargs = dict(
        goal_position=maybe_int("goalPosition"),
        goal_velocity=maybe_int("goalVelocity"),
        goal_current=maybe_int("goalCurrent"),
        goal_pwm=maybe_int("goalPwm"),
        profile_velocity=maybe_int("profileVelocity"),
        profile_accel=maybe_int("profileAccel"),
    )

    try:
        controller.set_goals(dxl_id, **kwargs)
        emit("log", {"level": "info", "message": f"ID {dxl_id}: updated goals {kwargs}"})
    except DynamixelError as e:
        emit("log", {"level": "error", "message": f"Failed to set goals on ID {dxl_id}: {e}"})


# Clean up
@atexit.register
def shutdown():
    global running
    running = False
    disconnect_controller()

if __name__ == "__main__":
    print("[INFO] Starting Flask-SocketIO server on http://127.0.0.1:5000")
    socketio.run(app, host="0.0.0.0", port=5000)
