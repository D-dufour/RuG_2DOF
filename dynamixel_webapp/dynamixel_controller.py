import threading
import time
from typing import Dict, Any, List, Optional
from dynamixel_sdk import PortHandler, PacketHandler, COMM_SUCCESS
from config import DEFAULT_BAUDRATE

# Control table addresses for X-series / XC330-M288-T
ADDR_OPERATING_MODE = 11
ADDR_TORQUE_ENABLE = 64
ADDR_VELOCITY_I_GAIN = 76
ADDR_VELOCITY_P_GAIN = 78
ADDR_POSITION_D_GAIN = 80
ADDR_POSITION_I_GAIN = 82
ADDR_POSITION_P_GAIN = 84
ADDR_PROFILE_ACCEL = 108
ADDR_PROFILE_VELOCITY = 112
ADDR_GOAL_PWM = 100
ADDR_GOAL_CURRENT = 102
ADDR_GOAL_VELOCITY = 104
ADDR_GOAL_POSITION = 116
ADDR_PRESENT_PWM = 124
ADDR_PRESENT_CURRENT = 126
ADDR_PRESENT_VELOCITY = 128
ADDR_PRESENT_POSITION = 132
ADDR_MOVING = 122
OPERATING_MODE_NAMES = {
    0: "Current Control Mode",
    1: "Velocity Control Mode",
    3: "Position Control Mode",
    4: "Extended Position Control Mode",
    5: "Current-based Position Mode",
    16: "PWM Control Mode",
}


class DynamixelError(Exception):
    """Dynamixel communication problems."""

class DynamixelController:

    def __init__(self, port: str, baudrate: int, ids: List[int]):
        self.port_name = port
        self.baudrate = baudrate
        self.ids = list(ids)
        self.port_handler = PortHandler(port)
        self.packet_handler = PacketHandler(2.0)
        self.lock = threading.Lock()

        if not self.port_handler.openPort():
            raise DynamixelError(f"Failed to open port {port}")
        if not self.port_handler.setBaudRate(baudrate):
            raise DynamixelError(f"Failed to set baudrate {baudrate} on {port}")

        print(f"[INFO] Opened Dynamixel port {port} @ {baudrate}")
        for dxl_id in self.ids:
            try:
                model = self.get_model_number(dxl_id)
                print(f"[INFO] ID {dxl_id} model number: {model}")
            except DynamixelError as exc:
                print(f"[ERROR] Failed to ping ID {dxl_id}: {exc}")

    # Read the data from the servos

    def _read1(self, dxl_id: int, addr: int) -> int:
        with self.lock:
            value, dxl_comm_result, dxl_error = self.packet_handler.read1ByteTxRx(
                self.port_handler, dxl_id, addr
            )
        if dxl_comm_result != COMM_SUCCESS:
            raise DynamixelError(
                f"Failed to read (ID {dxl_id}, addr {addr}): "
                f"{self.packet_handler.getTxRxResult(dxl_comm_result)}"
            )
        if dxl_error != 0:
            raise DynamixelError(
                f"Failed to read (ID {dxl_id}, addr {addr}): "
                f"{self.packet_handler.getRxPacketError(dxl_error)}"
            )
        return value

    def _read2(self, dxl_id: int, addr: int) -> int:
        with self.lock:
            value, dxl_comm_result, dxl_error = self.packet_handler.read2ByteTxRx(
                self.port_handler, dxl_id, addr
            )
        if dxl_comm_result != COMM_SUCCESS:
            raise DynamixelError(
                f"Failed to read (ID {dxl_id}, addr {addr}): "
                f"{self.packet_handler.getTxRxResult(dxl_comm_result)}"
            )
        if dxl_error != 0:
            raise DynamixelError(
                f"Failed to read (ID {dxl_id}, addr {addr}): "
                f"{self.packet_handler.getRxPacketError(dxl_error)}"
            )
        # Handle signed 16-bit (for current, PWM)
        if value & 0x8000:
            value -= 0x10000
        return value

    def _read4(self, dxl_id: int, addr: int) -> int:
        with self.lock:
            value, dxl_comm_result, dxl_error = self.packet_handler.read4ByteTxRx(
                self.port_handler, dxl_id, addr
            )
        if dxl_comm_result != COMM_SUCCESS:
            raise DynamixelError(
                f"Failed to read (ID {dxl_id}, addr {addr}): "
                f"{self.packet_handler.getTxRxResult(dxl_comm_result)}"
            )
        if dxl_error != 0:
            raise DynamixelError(
                f"Failed to read (ID {dxl_id}, addr {addr}): "
                f"{self.packet_handler.getRxPacketError(dxl_error)}"
            )
        # Handle signed 32-bit (for velocity, position)
        if value & 0x80000000:
            value -= 0x100000000
        return value

    # Write commands to the servos
    
    def _write1(self, dxl_id: int, addr: int, value: int):
        with self.lock:
            dxl_comm_result, dxl_error = self.packet_handler.write1ByteTxRx(
                self.port_handler, dxl_id, addr, value & 0xFF
            )
        if dxl_comm_result != COMM_SUCCESS:
            raise DynamixelError(
                f"Failed to write (ID {dxl_id}, addr {addr}): "
                f"{self.packet_handler.getTxRxResult(dxl_comm_result)}"
            )
        if dxl_error != 0:
            raise DynamixelError(
                f"Failed to write (ID {dxl_id}, addr {addr}): "
                f"{self.packet_handler.getRxPacketError(dxl_error)}"
            )

    def _write2(self, dxl_id: int, addr: int, value: int):
        with self.lock:
            dxl_comm_result, dxl_error = self.packet_handler.write2ByteTxRx(
                self.port_handler, dxl_id, addr, value & 0xFFFF
            )
        if dxl_comm_result != COMM_SUCCESS:
            raise DynamixelError(
                f"Failed to write (ID {dxl_id}, addr {addr}): "
                f"{self.packet_handler.getTxRxResult(dxl_comm_result)}"
            )
        if dxl_error != 0:
            raise DynamixelError(
                f"Failed to write (ID {dxl_id}, addr {addr}): "
                f"{self.packet_handler.getRxPacketError(dxl_error)}"
            )

    def _write4(self, dxl_id: int, addr: int, value: int):
        with self.lock:
            dxl_comm_result, dxl_error = self.packet_handler.write4ByteTxRx(
                self.port_handler, dxl_id, addr, value & 0xFFFFFFFF
            )
        if dxl_comm_result != COMM_SUCCESS:
            raise DynamixelError(
                f"Failed to write (ID {dxl_id}, addr {addr}): "
                f"{self.packet_handler.getTxRxResult(dxl_comm_result)}"
            )
        if dxl_error != 0:
            raise DynamixelError(
                f"Failed to write (ID {dxl_id}, addr {addr}): "
                f"{self.packet_handler.getRxPacketError(dxl_error)}"
            )

    # Operations

    def get_model_number(self, dxl_id: int) -> int:
        """Ping servo and return model number."""
        with self.lock:
            model_number, dxl_comm_result, dxl_error = self.packet_handler.ping(
                self.port_handler, dxl_id
            )
        if dxl_comm_result != COMM_SUCCESS:
            raise DynamixelError(
                f"Ping failed (ID {dxl_id}): "
                f"{self.packet_handler.getTxRxResult(dxl_comm_result)}"
            )
        if dxl_error != 0:
            raise DynamixelError(
                f"Ping error (ID {dxl_id}): "
                f"{self.packet_handler.getRxPacketError(dxl_error)}"
            )
        return model_number

    def set_torque(self, dxl_id: int, enable: bool):
        self._write1(dxl_id, ADDR_TORQUE_ENABLE, 1 if enable else 0)

    def set_operating_mode(self, dxl_id: int, mode: int, auto_torque: bool = True):
        if auto_torque:
            # disable torque before mode change
            try:
                self.set_torque(dxl_id, False)
            except DynamixelError:
                # ignore if already disabled
                pass
        self._write1(dxl_id, ADDR_OPERATING_MODE, mode)
        if auto_torque:
            # re-enable torque
            self.set_torque(dxl_id, True)

    def set_pid(
        self,
        dxl_id: int,
        position_p: Optional[int] = None,
        position_i: Optional[int] = None,
        position_d: Optional[int] = None,
        velocity_p: Optional[int] = None,
        velocity_i: Optional[int] = None,
    ):
        if position_p is not None:
            self._write2(dxl_id, ADDR_POSITION_P_GAIN, position_p)
        if position_i is not None:
            self._write2(dxl_id, ADDR_POSITION_I_GAIN, position_i)
        if position_d is not None:
            self._write2(dxl_id, ADDR_POSITION_D_GAIN, position_d)
        if velocity_p is not None:
            self._write2(dxl_id, ADDR_VELOCITY_P_GAIN, velocity_p)
        if velocity_i is not None:
            self._write2(dxl_id, ADDR_VELOCITY_I_GAIN, velocity_i)

    def set_goals(
        self,
        dxl_id: int,
        goal_position: Optional[int] = None,
        goal_velocity: Optional[int] = None,
        goal_current: Optional[int] = None,
        goal_pwm: Optional[int] = None,
        profile_velocity: Optional[int] = None,
        profile_accel: Optional[int] = None,
    ):
        if profile_accel is not None:
            self._write4(dxl_id, ADDR_PROFILE_ACCEL, profile_accel)
        if profile_velocity is not None:
            self._write4(dxl_id, ADDR_PROFILE_VELOCITY, profile_velocity)
        if goal_pwm is not None:
            self._write2(dxl_id, ADDR_GOAL_PWM, goal_pwm)
        if goal_current is not None:
            self._write2(dxl_id, ADDR_GOAL_CURRENT, goal_current)
        if goal_velocity is not None:
            self._write4(dxl_id, ADDR_GOAL_VELOCITY, goal_velocity)
        if goal_position is not None:
            self._write4(dxl_id, ADDR_GOAL_POSITION, goal_position)

    # Read Telemtry
    def read_state(self, dxl_id: int) -> Dict[str, Any]:
        state: Dict[str, Any] = {}
        try:
            state["operating_mode"] = self._read1(dxl_id, ADDR_OPERATING_MODE)
            state["torque_enabled"] = bool(self._read1(dxl_id, ADDR_TORQUE_ENABLE))
            state["present_pwm"] = self._read2(dxl_id, ADDR_PRESENT_PWM)
            state["present_current"] = self._read2(dxl_id, ADDR_PRESENT_CURRENT)
            state["present_velocity"] = self._read4(dxl_id, ADDR_PRESENT_VELOCITY)
            state["present_position"] = self._read4(dxl_id, ADDR_PRESENT_POSITION)
            state["moving"] = bool(self._read1(dxl_id, ADDR_MOVING))
            mode = state.get("operating_mode", 0)
            state["operating_mode_name"] = OPERATING_MODE_NAMES.get(mode, f"Mode {mode}")
        except DynamixelError as exc:
            state["error"] = str(exc)
        return state

    def read_all(self) -> Dict[int, Dict[str, Any]]:
        result: Dict[int, Dict[str, Any]] = {}
        for dxl_id in self.ids:
            result[dxl_id] = self.read_state(dxl_id)
        return result

    def read_all_states(self) -> Dict[int, Dict[str, Any]]:
        return self.read_all()

    def close(self):
        with self.lock:
            if self.port_handler is not None:
                try:
                    self.port_handler.closePort()
                except Exception:
                    pass
                finally:
                    print(f"[INFO] Closed Dynamixel port {self.port_name}")
