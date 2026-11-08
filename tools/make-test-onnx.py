"""Create a TEST-ONLY ONNX model with the same I/O signature as MODNet
([1,3,H,W] float in -1..1 -> [1,1,H,W] alpha). It is NOT a matting model: it
just outputs sigmoid(4 * mean(RGB)). Used only to verify the ONNX Runtime Web
loading/inference path in the automated tests. Never ship it as a real model.
Usage: python3 tools/make-test-onnx.py tests/fixtures/test-only-matting-signature.onnx
"""
import sys
import onnx
from onnx import helper, TensorProto

inp = helper.make_tensor_value_info('input', TensorProto.FLOAT, [1, 3, 'H', 'W'])
out = helper.make_tensor_value_info('output', TensorProto.FLOAT, [1, 1, 'H', 'W'])
k = helper.make_tensor('k', TensorProto.FLOAT, [], [4.0])
nodes = [
    helper.make_node('ReduceMean', ['input'], ['m'], axes=[1], keepdims=1),
    helper.make_node('Mul', ['m', 'k'], ['s']),
    helper.make_node('Sigmoid', ['s'], ['output']),
]
graph = helper.make_graph(nodes, 'test_only_matting_signature', [inp], [out], initializer=[k])
model = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 13)], producer_name='hoshmand-tests')
model.ir_version = 8
onnx.checker.check_model(model)
onnx.save(model, sys.argv[1])
print('wrote', sys.argv[1])
